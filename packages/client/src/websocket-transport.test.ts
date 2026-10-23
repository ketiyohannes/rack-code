/**
 * The reconnect loop is driven with an injected socket rather than a real
 * one, so the behaviour that matters — queueing while offline, resuming
 * from the right cursor, refusing to retry a rejected token — is tested
 * deterministically instead of against timing.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "@rack/contracts";
import type { HostEvent } from "@rack/contracts/events";

import { createWebSocketTransport, type WebSocketLike } from "./websocket-transport.js";
import type { ConnectionStatus } from "./transport.js";

const event = (sessionId: string): HostEvent => ({ type: "sessions.changed", sessionId });

/** A socket the test opens, feeds and kills by hand. */
class FakeSocket implements WebSocketLike {
  readonly sent: ClientFrame[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closedByClient = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }
  close(): void {
    this.closedByClient = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }
  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Simulates the network dropping, as opposed to a deliberate close. */
  drop(): void {
    this.onclose?.({});
  }
  welcome(overrides: Partial<Extract<ServerFrame, { kind: "welcome" }>> = {}): void {
    this.deliver({
      kind: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      machineId: "m1",
      instanceId: "i1",
      nextSequence: 1,
      resume: "fresh",
      ...overrides,
    });
  }
  get hello(): Extract<ClientFrame, { kind: "hello" }> | undefined {
    return this.sent.find((frame): frame is Extract<ClientFrame, { kind: "hello" }> => frame.kind === "hello");
  }
  get requests(): Extract<ClientFrame, { kind: "request" }>[] {
    return this.sent.filter((frame): frame is Extract<ClientFrame, { kind: "request" }> => frame.kind === "request");
  }
}

function harness(options: { maxBackoffMs?: number } = {}): {
  sockets: FakeSocket[];
  statuses: ConnectionStatus[];
  transport: ReturnType<typeof createWebSocketTransport>;
} {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const transport = createWebSocketTransport({
    url: "ws://daemon.test/rack",
    token: "pairing-token",
    clientId: "client-1",
    heartbeatMs: 10_000,
    maxBackoffMs: options.maxBackoffMs ?? 2,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  transport.onStatus?.((status) => statuses.push(status));
  return { sockets, statuses, transport };
}

/** Lets the reconnect timer fire. */
const settle = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("the handshake carries the token and the client is only usable after welcome", async () => {
  const { sockets, transport } = harness();
  const socket = sockets[0]!;
  socket.open();

  assert.equal(socket.hello?.token, "pairing-token");
  assert.equal(socket.hello?.protocolVersion, PROTOCOL_VERSION);
  assert.equal(socket.hello?.resumeFrom, undefined, "a first connection has nothing to resume");

  // Issued before welcome: queued, not sent, and certainly not failed.
  const pending = transport.invoke("runs.active", {} as never);
  assert.deepEqual(socket.requests, [], "an unauthorized socket is not used for commands");

  socket.welcome();
  assert.equal(socket.requests.length, 1, "the queued command is flushed on welcome");
  socket.deliver({ kind: "response", id: socket.requests[0]!.id, response: { ok: true, value: "ok" } });
  assert.deepEqual(await pending, { ok: true, value: "ok" });
  transport.close();
});

test("a command issued while offline is sent on reconnect rather than failed", async () => {
  const { sockets, transport } = harness();
  sockets[0]!.open();
  sockets[0]!.welcome();
  sockets[0]!.drop();

  // The UI keeps working during a blip; failing a command that never
  // reached the network would make a recovered connection look like an
  // outage to the user.
  const pending = transport.invoke("runs.active", {} as never);
  await settle();

  const reconnected = sockets[1];
  assert.ok(reconnected, "the transport retried");
  reconnected.open();
  reconnected.welcome();
  assert.equal(reconnected.requests.length, 1, "the queued command went out on the new socket");

  reconnected.deliver({ kind: "response", id: reconnected.requests[0]!.id, response: { ok: true, value: 42 } });
  assert.deepEqual(await pending, { ok: true, value: 42 });
  transport.close();
});

test("a command already in flight is failed, not silently retried", async () => {
  const { sockets, transport } = harness();
  sockets[0]!.open();
  sockets[0]!.welcome();

  const pending = transport.invoke("projects.add", {} as never);
  assert.equal(sockets[0]!.requests.length, 1, "the command reached the socket");

  // The daemon may well have executed it before the link died. Replaying
  // a mutating command would duplicate real state, so the honest answer is
  // that its outcome is unknown.
  sockets[0]!.drop();
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.ok === false ? response.error.code : undefined, "host_unavailable");
  assert.match(
    response.ok === false ? response.error.message : "",
    /may or may not have run/,
    "the message does not claim the command failed",
  );

  await settle();
  const reconnected = sockets[1]!;
  reconnected.open();
  reconnected.welcome();
  assert.deepEqual(reconnected.requests, [], "nothing was resent");
  transport.close();
});

test("reconnecting resumes from the last applied sequence", async () => {
  const { sockets, transport } = harness();
  const delivered: HostEvent[] = [];
  transport.onEvent((hostEvent) => delivered.push(hostEvent));

  sockets[0]!.open();
  sockets[0]!.welcome();
  sockets[0]!.deliver({ kind: "event", sequence: 1, event: event("a") });
  sockets[0]!.deliver({ kind: "event", sequence: 2, event: event("b") });
  sockets[0]!.drop();
  await settle();

  const reconnected = sockets[1]!;
  reconnected.open();
  assert.equal(reconnected.hello?.resumeFrom, 2, "the cursor is the highest sequence actually applied");

  reconnected.welcome({ resume: "replayed" });
  reconnected.deliver({ kind: "event", sequence: 3, event: event("c") });
  assert.deepEqual(delivered.map((entry) => (entry.type === "sessions.changed" ? entry.sessionId : "")), ["a", "b", "c"]);
  transport.close();
});

test("duplicate or out-of-order event frames are ignored", () => {
  const { sockets, transport } = harness();
  const delivered: string[] = [];
  transport.onEvent((hostEvent) => {
    if (hostEvent.type === "sessions.changed") delivered.push(hostEvent.sessionId);
  });
  sockets[0]!.open();
  sockets[0]!.welcome();

  sockets[0]!.deliver({ kind: "event", sequence: 1, event: event("a") });
  sockets[0]!.deliver({ kind: "event", sequence: 1, event: event("duplicate") });
  sockets[0]!.deliver({ kind: "event", sequence: 0, event: event("stale") });
  sockets[0]!.deliver({ kind: "event", sequence: 2, event: event("b") });

  assert.deepEqual(delivered, ["a", "b"], "replaying a frame must not corrupt the cursor");
  transport.close();
});

test("a restarted daemon resets the cursor instead of resuming into a dead stream", async () => {
  const { sockets, transport } = harness();
  sockets[0]!.open();
  sockets[0]!.welcome({ instanceId: "first" });
  sockets[0]!.deliver({ kind: "event", sequence: 5, event: event("a") });
  sockets[0]!.drop();
  await settle();

  const reconnected = sockets[1]!;
  reconnected.open();
  assert.equal(reconnected.hello?.resumeFrom, 5);
  // The daemon identifies itself as a different process, so the sequence
  // numbers the client remembers refer to a stream that no longer exists.
  reconnected.welcome({ instanceId: "second", resume: "truncated" });
  reconnected.drop();
  await settle();

  assert.equal(sockets[2]?.hello?.resumeFrom, undefined, "the stale cursor was discarded");
  transport.close();
});

test("a truncated resume is surfaced so the interface can re-read state", async () => {
  const { sockets, statuses, transport } = harness();
  sockets[0]!.open();
  sockets[0]!.welcome({ resume: "truncated" });

  const online = statuses.find((status) => status.state === "online");
  assert.equal(online?.resume, "truncated");
  transport.close();
});

test("a rejected handshake is fatal and is not retried", async () => {
  const { sockets, statuses, transport } = harness();
  sockets[0]!.open();
  const pending = transport.invoke("runs.active", {} as never);
  sockets[0]!.deliver({ kind: "rejected", reason: "unauthorized", message: "The pairing token was not accepted." });

  const response = await pending;
  assert.equal(response.ok, false, "queued commands fail rather than hang for ever");
  assert.equal(response.ok === false ? response.error.code : undefined, "host_unavailable");

  const fatal = statuses.find((status) => status.fatal === true);
  assert.equal(fatal?.state, "offline");
  assert.equal(fatal?.detail, "The pairing token was not accepted.");

  await settle();
  assert.equal(sockets.length, 1, "retrying a refused token would lock the user out silently");
  transport.close();
});

test("closing the transport fails in-flight commands and stops reconnecting", async () => {
  const { sockets, transport } = harness();
  sockets[0]!.open();
  sockets[0]!.welcome();
  const pending = transport.invoke("runs.active", {} as never);

  transport.close?.();
  const response = await pending;
  assert.equal(response.ok, false);

  await settle();
  assert.equal(sockets.length, 1, "a closed transport does not reconnect");
  const afterClose = await transport.invoke("runs.active", {} as never);
  assert.equal(afterClose.ok, false, "later commands fail fast instead of queueing for ever");
});

test("an unanswered heartbeat forces a reconnect", async () => {
  const sockets: FakeSocket[] = [];
  const transport = createWebSocketTransport({
    url: "ws://daemon.test/rack",
    token: "t",
    clientId: "c",
    heartbeatMs: 5,
    maxBackoffMs: 2,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  sockets[0]!.open();
  sockets[0]!.welcome();

  // A link that is silently dead still looks open to TCP for minutes; the
  // ping is what makes the client notice and show the truth.
  await settle(40);
  assert.ok(sockets.length > 1, "the dead link was replaced");
  transport.close();
});
