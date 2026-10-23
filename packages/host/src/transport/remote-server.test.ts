import assert from "node:assert/strict";
import test from "node:test";

import type { HostEvent } from "@rack/contracts/events";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "@rack/contracts/protocol";
import type { CommandResponse } from "@rack/contracts/transport";

import { EventStream } from "./event-stream.js";
import { RemoteHostServer } from "./remote-server.js";
import type { HostConnection, HostEndpoint } from "./connection.js";

const event = (sessionId: string): HostEvent => ({ type: "sessions.changed", sessionId });

/** In-memory connection: records what the server sent and injects frames. */
class FakeConnection implements HostConnection {
  readonly sent: ServerFrame[] = [];
  readonly remoteAddress = "test";
  closed: string | undefined;
  private message: ((data: string) => void) | undefined;
  private closeListener: (() => void) | undefined;

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }
  close(reason: string): void {
    this.closed = reason;
    this.closeListener?.();
  }
  onMessage(listener: (data: string) => void): void {
    this.message = listener;
  }
  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  /** Delivers a frame as the peer would. */
  receive(frame: ClientFrame | string): void {
    this.message?.(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  hello(overrides: Partial<Extract<ClientFrame, { kind: "hello" }>> = {}): void {
    this.receive({ kind: "hello", protocolVersion: PROTOCOL_VERSION, token: "good", clientId: "client-1", ...overrides });
  }
  frames<K extends ServerFrame["kind"]>(kind: K): Extract<ServerFrame, { kind: K }>[] {
    return this.sent.filter((frame): frame is Extract<ServerFrame, { kind: K }> => frame.kind === kind);
  }
}

function setup(options: { endpoint?: HostEndpoint; events?: EventStream } = {}): {
  server: RemoteHostServer;
  events: EventStream;
  dispatched: { command: unknown; params: unknown }[];
} {
  const dispatched: { command: unknown; params: unknown }[] = [];
  const events = options.events ?? new EventStream();
  const endpoint: HostEndpoint = options.endpoint ?? {
    dispatch: (command, params) => {
      dispatched.push({ command, params });
      return Promise.resolve({ ok: true, value: "done" } satisfies CommandResponse);
    },
    shutdown: () => Promise.resolve(0),
  };
  const server = new RemoteHostServer({
    endpoint,
    events,
    machineId: "machine-1",
    instanceId: "instance-1",
    authorize: (token) => token === "good",
  });
  return { server, events, dispatched };
}

test("a valid handshake is welcomed and commands are dispatched", async () => {
  const { server, dispatched } = setup();
  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello();

  const welcome = connection.frames("welcome")[0];
  assert.ok(welcome, "the server answers hello with welcome");
  assert.equal(welcome.machineId, "machine-1");
  assert.equal(welcome.instanceId, "instance-1");
  assert.equal(welcome.resume, "fresh");
  assert.equal(server.connectionCount, 1);

  connection.receive({ kind: "request", id: 7, command: "runs.active", params: { a: 1 } });
  await Promise.resolve();
  assert.deepEqual(dispatched, [{ command: "runs.active", params: { a: 1 } }]);
  const response = connection.frames("response")[0];
  assert.ok(response);
  assert.equal(response.id, 7, "the response carries the request's ID");
});

test("commands are refused until the handshake succeeds", async () => {
  const { server, dispatched } = setup();
  const connection = new FakeConnection();
  server.accept(connection);

  // Skipping hello must not be a route around authorization.
  connection.receive({ kind: "request", id: 1, command: "runs.active", params: {} });
  await Promise.resolve();

  assert.deepEqual(dispatched, [], "nothing reached the host");
  assert.equal(connection.frames("rejected")[0]?.reason, "malformed_handshake");
  assert.ok(connection.closed, "the connection was closed");
  assert.equal(server.connectionCount, 0);
});

test("a bad token and an unsupported version are both refused", () => {
  const { server } = setup();

  const wrongToken = new FakeConnection();
  server.accept(wrongToken);
  wrongToken.hello({ token: "bad" });
  assert.equal(wrongToken.frames("rejected")[0]?.reason, "unauthorized");

  const oldClient = new FakeConnection();
  server.accept(oldClient);
  oldClient.hello({ protocolVersion: PROTOCOL_VERSION + 99 });
  assert.equal(oldClient.frames("rejected")[0]?.reason, "unsupported_protocol");

  const garbage = new FakeConnection();
  server.accept(garbage);
  garbage.receive("{not json");
  assert.equal(garbage.frames("rejected")[0]?.reason, "malformed_handshake");

  assert.equal(server.connectionCount, 0, "no refused connection is tracked");
});

test("the rejection message never echoes the token back", () => {
  const { server } = setup();
  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello({ token: "super-secret-value" });

  const rejected = connection.frames("rejected")[0];
  assert.ok(rejected);
  assert.ok(!JSON.stringify(rejected).includes("super-secret-value"));
});

test("live events reach an authenticated controller and stop at disconnect", () => {
  const { server, events } = setup();
  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello();

  events.publish(event("a"));
  events.publish(event("b"));
  assert.deepEqual(connection.frames("event").map((frame) => frame.sequence), [1, 2]);

  connection.close("gone");
  events.publish(event("c"));
  assert.equal(connection.frames("event").length, 2, "a closed connection is unsubscribed");
  assert.equal(server.connectionCount, 0);
});

test("a resuming controller is sent exactly the events it missed", () => {
  const { server, events } = setup();
  for (const id of ["a", "b", "c"]) events.publish(event(id));

  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello({ resumeFrom: 1 });

  assert.equal(connection.frames("welcome")[0]?.resume, "replayed");
  assert.deepEqual(connection.frames("event").map((frame) => frame.sequence), [2, 3]);
});

test("a resume older than the buffer is reported as truncated rather than silently short", () => {
  const events = new EventStream({ bufferSize: 2 });
  const { server } = setup({ events });
  for (const id of ["a", "b", "c", "d"]) events.publish(event(id));

  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello({ resumeFrom: 1 });

  assert.equal(connection.frames("welcome")[0]?.resume, "truncated");
  assert.deepEqual(connection.frames("event"), [], "a truncated resume replays nothing; the client re-reads state");
});

test("an event published during the handshake is delivered once, in order", () => {
  const events = new EventStream();
  const { server } = setup({ events });
  for (const id of ["a", "b"]) events.publish(event(id));

  const connection = new FakeConnection();
  server.accept(connection);
  // Publishing from inside the handshake is the race the server guards
  // against: it subscribes before reading the replay buffer, so this event
  // is queued and then flushed without being duplicated or dropped.
  const original = connection.send.bind(connection);
  let injected = false;
  connection.send = (frame: ServerFrame) => {
    original(frame);
    if (frame.kind === "welcome" && !injected) {
      injected = true;
      events.publish(event("during-handshake"));
    }
  };
  connection.hello({ resumeFrom: 1 });

  assert.deepEqual(
    connection.frames("event").map((frame) => frame.sequence),
    [2, 3],
    "the replayed gap and the event raced in during the handshake, each exactly once",
  );
});

test("a host that throws still answers the request that caused it", async () => {
  const endpoint: HostEndpoint = {
    dispatch: () => Promise.reject(new Error("the host broke")),
    shutdown: () => Promise.resolve(0),
  };
  const { server } = setup({ endpoint });
  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello();

  connection.receive({ kind: "request", id: 42, command: "runs.active", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const response = connection.frames("response")[0];
  assert.ok(response, "a pending call must never hang");
  assert.equal(response.id, 42);
  assert.equal(response.response.ok, false);
  assert.equal(response.response.ok === false ? response.response.error.code : undefined, "internal");
});

test("ping is answered and closeAll drops every controller", () => {
  const { server } = setup();
  const connection = new FakeConnection();
  server.accept(connection);
  connection.hello();

  connection.receive({ kind: "ping", id: 3 });
  assert.equal(connection.frames("pong")[0]?.id, 3);

  server.closeAll("shutting down");
  assert.equal(connection.closed, "shutting down");
  assert.equal(server.connectionCount, 0);
});
