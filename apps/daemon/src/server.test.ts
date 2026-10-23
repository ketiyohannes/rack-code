/**
 * End-to-end checks over real sockets.
 *
 * The protocol rules are unit-tested in `@rack/host` with fakes. What this
 * file proves is that the daemon's actual `ws` wiring honours them: that the
 * upgrade path is gated, that a controller surviving a daemon restart gets
 * told its stream is gone, and that a reconnect with a live buffer is
 * replayed exactly.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "@rack/contracts/protocol";
import type { HostEvent } from "@rack/contracts/events";
import { EventStream, type HostEndpoint } from "@rack/host";

import { DaemonServer, WEBSOCKET_PATH } from "./server.js";

const event = (sessionId: string): HostEvent => ({ type: "sessions.changed", sessionId });

const endpoint: HostEndpoint = {
  dispatch: (command, params) => Promise.resolve({ ok: true, value: { command, params } }),
  shutdown: () => Promise.resolve(0),
};

/** Minimal protocol client, so this test does not depend on `@rack/client`. */
class TestClient {
  private readonly socket: WebSocket;
  readonly received: ServerFrame[] = [];
  private readonly waiters: { match: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String((message as MessageEvent).data)) as ServerFrame;
      this.received.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
  }

  opened(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("The socket failed to open.")), { once: true });
    });
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Resolves with the next frame of `kind`, failing the test on timeout. */
  next<K extends ServerFrame["kind"]>(kind: K, timeoutMs = 2000): Promise<Extract<ServerFrame, { kind: K }>> {
    const existing = this.received.find((frame): frame is Extract<ServerFrame, { kind: K }> => frame.kind === kind);
    if (existing !== undefined) {
      this.received.splice(this.received.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No "${kind}" frame arrived within ${String(timeoutMs)}ms.`)), timeoutMs);
      this.waiters.push({
        match: (frame) => frame.kind === kind,
        resolve: (frame) => {
          clearTimeout(timer);
          this.received.splice(this.received.indexOf(frame), 1);
          resolve(frame as Extract<ServerFrame, { kind: K }>);
        },
      });
    });
  }

  closed(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => this.socket.addEventListener("close", () => resolve(), { once: true }));
  }

  close(): void {
    this.socket.close();
  }
}

async function withServer(
  events: EventStream,
  body: (url: string, server: DaemonServer, port: number) => Promise<void>,
  options: { port?: number; instanceId?: string } = {},
): Promise<number> {
  const server = new DaemonServer({
    endpoint,
    events,
    machineId: "test-machine",
    instanceId: options.instanceId ?? "instance-1",
    authorize: (token) => token === "good-token",
  });
  const port = await server.listen("127.0.0.1", options.port ?? 0);
  try {
    await body(`ws://127.0.0.1:${String(port)}${WEBSOCKET_PATH}`, server, port);
  } finally {
    await server.close("test over");
  }
  return port;
}

test("a paired controller completes a command round trip over a real socket", async () => {
  await withServer(new EventStream(), async (url) => {
    const client = new TestClient(url);
    await client.opened();
    client.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, token: "good-token", clientId: "c1" });

    const welcome = await client.next("welcome");
    assert.equal(welcome.machineId, "test-machine");
    assert.equal(welcome.resume, "fresh");

    client.send({ kind: "request", id: 1, command: "runs.active", params: { projectId: "p" } });
    const response = await client.next("response");
    assert.equal(response.id, 1);
    assert.equal(response.response.ok, true);

    client.send({ kind: "ping", id: 2 });
    assert.equal((await client.next("pong")).id, 2);
    client.close();
  });
});

test("a wrong token is refused and the socket is closed", async () => {
  await withServer(new EventStream(), async (url, server) => {
    const client = new TestClient(url);
    await client.opened();
    client.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, token: "wrong", clientId: "c1" });

    const rejected = await client.next("rejected");
    assert.equal(rejected.reason, "unauthorized");
    await client.closed();
    assert.equal(server.connectionCount, 0);
  });
});

test("only the protocol path accepts an upgrade", async () => {
  await withServer(new EventStream(), async (_url, _server, port) => {
    const stray = new TestClient(`ws://127.0.0.1:${String(port)}/not-rack`);
    await assert.rejects(stray.opened(), "an upgrade on another path is refused");
  });
});

test("health reports liveness without requiring the pairing token", async () => {
  await withServer(new EventStream(), async (_url, _server, port) => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; machineId: string; protocolVersion: number };
    assert.equal(body.status, "ok");
    assert.equal(body.machineId, "test-machine");
    assert.equal(body.protocolVersion, PROTOCOL_VERSION);
    // A VM supervisor polls this; it must never carry a secret.
    assert.ok(!JSON.stringify(body).includes("good-token"));
  });
});

test("a controller that reconnects within the buffer is replayed exactly", async () => {
  const events = new EventStream();
  await withServer(events, async (url) => {
    const first = new TestClient(url);
    await first.opened();
    first.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, token: "good-token", clientId: "c1" });
    await first.next("welcome");

    events.publish(event("a"));
    const seen = await first.next("event");
    assert.equal(seen.sequence, 1);
    first.close();
    await first.closed();

    // Events the controller missed while disconnected.
    events.publish(event("b"));
    events.publish(event("c"));

    const resumed = new TestClient(url);
    await resumed.opened();
    resumed.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, token: "good-token", clientId: "c1", resumeFrom: 1 });

    const welcome = await resumed.next("welcome");
    assert.equal(welcome.resume, "replayed");
    assert.equal((await resumed.next("event")).sequence, 2);
    assert.equal((await resumed.next("event")).sequence, 3);
    resumed.close();
  });
});

test("a controller resuming against a restarted daemon is told its stream is gone", async () => {
  // The first daemon publishes three events, then dies. The replacement
  // numbers from one again, so the controller's cursor is meaningless and
  // reusing it would leave the UI permanently stale.
  const firstRun = new EventStream();
  const port = await withServer(firstRun, async () => {
    for (const id of ["a", "b", "c"]) firstRun.publish(event(id));
  }, { instanceId: "instance-1" });

  await withServer(new EventStream(), async (url) => {
    const client = new TestClient(url);
    await client.opened();
    client.send({ kind: "hello", protocolVersion: PROTOCOL_VERSION, token: "good-token", clientId: "c1", resumeFrom: 3 });

    const welcome = await client.next("welcome");
    assert.equal(welcome.resume, "truncated");
    assert.equal(welcome.instanceId, "instance-2", "a new instance id tells the client to discard its cursor");
    client.close();
  }, { port, instanceId: "instance-2" });
});
