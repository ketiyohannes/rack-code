/**
 * `ClientTransport` over a WebSocket to a remote daemon.
 *
 * Unlike the preload bridge, this link is expected to fail: laptops sleep,
 * phones change networks, VPS connections reset. The transport therefore
 * owns a reconnect loop and the client half of the resume handshake in
 * `@rack/contracts/protocol`.
 *
 * Decisions worth knowing before changing this file:
 *
 * - **Commands that never reached the socket wait; commands that did are
 *   not retried.** The UI calls commands as soon as it mounts, long before
 *   a socket can be open, and rejecting those would make a healthy startup
 *   look like an outage — so an unsent call is queued and flushed on
 *   `welcome`. A call that *was* written and then lost its connection is a
 *   different thing entirely: the daemon may well have executed it, and
 *   replaying `projects.add` or `sessions.create` would duplicate real
 *   state. Those fail with `host_unavailable`, exactly as a pending command
 *   does when the desktop host process exits. Resending safely would need
 *   idempotency keys and daemon-side deduplication, which the protocol does
 *   not have.
 *
 * - **An unauthorized or version-rejected handshake is fatal.** Retrying a
 *   bad token forever would lock the user out of an account and tell them
 *   nothing. Those close the transport and surface `fatal` in the status.
 *   Transport-level failures (DNS, refused, reset) are retried with
 *   exponential backoff and jitter.
 *
 * - **Resume is an optimization, never a correctness requirement.** The
 *   transport tracks the highest sequence it has delivered and asks to
 *   resume from it. If the daemon answers `truncated`, the gap is gone; the
 *   status reports it and the UI re-reads state with ordinary read
 *   commands, which is always safe because events are a freshness signal.
 *
 * - **Heartbeats exist because TCP is too patient.** A silently dead link
 *   can look open for minutes, during which the UI shows stale runs. A ping
 *   that goes unanswered forces a reconnect.
 */
import {
  PROTOCOL_VERSION,
  connectionError,
  isServerFrame,
  type ClientFrame,
  type CommandParams,
  type CommandResponse,
  type CommandResult,
  type HostCommand,
  type HostEvent,
  type ServerFrame,
} from "@rack/contracts";

import type { ClientTransport, ConnectionStatus } from "./transport.js";

export interface WebSocketTransportOptions {
  /** Daemon endpoint, for example `wss://daemon.example.net/rack`. */
  readonly url: string;
  /** Pairing token for this device. Sent in the handshake, never in the URL. */
  readonly token: string;
  /** Stable per-installation identifier; used by the daemon for logging. */
  readonly clientId: string;
  /** How long a queued or in-flight command waits before failing. */
  readonly requestTimeoutMs?: number;
  /** Interval between liveness pings once connected. */
  readonly heartbeatMs?: number;
  /** Backoff ceiling between reconnection attempts. */
  readonly maxBackoffMs?: number;
  /**
   * WebSocket implementation. Defaults to the platform global, which exists
   * in browsers and in Node 22 and later; injectable for tests.
   */
  readonly socketFactory?: (url: string) => WebSocketLike;
}

/** The slice of the WebSocket API this transport uses. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((this: unknown, event: unknown) => void) | null;
  onclose: ((this: unknown, event: unknown) => void) | null;
  onerror: ((this: unknown, event: unknown) => void) | null;
  onmessage: ((this: unknown, event: { data: unknown }) => void) | null;
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  heartbeatMs: 15_000,
  maxBackoffMs: 30_000,
  initialBackoffMs: 500,
} as const;

interface Pending {
  readonly resolve: (response: CommandResponse) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly frame: ClientFrame;
  /**
   * Whether the frame reached a socket. Only unsent frames may be replayed;
   * see the note on at-most-once delivery at the top of this file.
   */
  sent: boolean;
}

export function createWebSocketTransport(options: WebSocketTransportOptions): ClientTransport {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const heartbeatMs = options.heartbeatMs ?? DEFAULTS.heartbeatMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const createSocket = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  const eventListeners = new Set<(event: HostEvent) => void>();
  const statusListeners = new Set<(status: ConnectionStatus) => void>();
  const pending = new Map<number, Pending>();

  let socket: WebSocketLike | undefined;
  /** True only between `welcome` and the socket closing. */
  let online = false;
  let closed = false;
  let nextRequestId = 1;
  /** Highest event sequence delivered to listeners; the resume cursor. */
  let lastSequence = 0;
  /** Changes when the daemon restarts; a new value invalidates `lastSequence`. */
  let instanceId: string | undefined;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let awaitingPong = false;

  function publishStatus(status: ConnectionStatus): void {
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch {
        // A failing status listener must not break the reconnect loop.
      }
    }
  }

  function send(frame: ClientFrame): boolean {
    if (!online || socket === undefined) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      // The socket died between the check and the write; the close handler
      // will run and the frame is replayed from `pending` on reconnect.
      return false;
    }
  }

  function settle(id: number, response: CommandResponse): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(response);
  }

  /** Writes a queued command and records that it is now in flight. */
  function dispatch(id: number): void {
    const entry = pending.get(id);
    if (entry === undefined || entry.sent) return;
    if (send(entry.frame)) entry.sent = true;
  }

  /**
   * Fails commands whose fate is unknown because the connection carrying
   * them died. Unsent commands stay queued for the next `welcome`.
   */
  function failInFlight(): void {
    for (const [id, entry] of [...pending.entries()]) {
      if (!entry.sent) continue;
      settle(id, {
        ok: false,
        error: connectionError("The connection dropped before the daemon answered. The command may or may not have run."),
      });
    }
  }

  /** Fails every in-flight command; used when retrying is pointless. */
  function failAll(message: string): void {
    for (const id of [...pending.keys()]) {
      settle(id, { ok: false, error: connectionError(message) });
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    awaitingPong = false;
  }

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (awaitingPong) {
        // The previous ping was never answered: the link is dead even
        // though the socket still looks open.
        awaitingPong = false;
        socket?.close();
        return;
      }
      awaitingPong = true;
      send({ kind: "ping", id: nextRequestId++ });
    }, heartbeatMs);
  }

  function handle(frame: ServerFrame): void {
    switch (frame.kind) {
      case "welcome": {
        // A restarted daemon numbers its events from the start again, so a
        // cursor from the previous instance must not be reused.
        if (instanceId !== undefined && instanceId !== frame.instanceId) lastSequence = 0;
        instanceId = frame.instanceId;
        online = true;
        attempt = 0;
        startHeartbeat();
        publishStatus({ state: "online", resume: frame.resume });
        // Only commands that never reached a socket are sent here.
        for (const id of [...pending.keys()]) dispatch(id);
        return;
      }
      case "rejected": {
        // Retrying a refused token or an unsupported version cannot succeed.
        closed = true;
        online = false;
        stopHeartbeat();
        failAll(frame.message);
        publishStatus({ state: "offline", detail: frame.message, fatal: true });
        socket?.close();
        return;
      }
      case "response":
        settle(frame.id, frame.response);
        return;
      case "event": {
        // Out-of-order or duplicate frames would corrupt the resume cursor.
        if (frame.sequence <= lastSequence) return;
        lastSequence = frame.sequence;
        for (const listener of eventListeners) {
          try {
            listener(frame.event);
          } catch {
            // One bad listener must not cost the others their events.
          }
        }
        return;
      }
      case "pong":
        awaitingPong = false;
        return;
    }
  }

  function connect(): void {
    if (closed) return;
    publishStatus({ state: "connecting" });
    let active: WebSocketLike;
    try {
      active = createSocket(options.url);
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    socket = active;

    active.onopen = () => {
      // `online` only becomes true on `welcome`; an open socket that has not
      // been authorized must not be used to send commands.
      const hello: ClientFrame = {
        kind: "hello",
        protocolVersion: PROTOCOL_VERSION,
        token: options.token,
        clientId: options.clientId,
        ...(lastSequence > 0 ? { resumeFrom: lastSequence } : {}),
      };
      try {
        active.send(JSON.stringify(hello));
      } catch (error) {
        scheduleReconnect(error instanceof Error ? error.message : String(error));
      }
    };

    active.onmessage = ({ data }) => {
      if (typeof data !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(data) as unknown;
      } catch {
        return;
      }
      if (isServerFrame(frame)) handle(frame);
    };

    active.onerror = () => {
      // Browsers deliberately withhold the cause of a WebSocket error, so
      // there is nothing more specific to report here; `onclose` follows.
    };

    active.onclose = () => {
      if (socket !== active) return;
      socket = undefined;
      online = false;
      stopHeartbeat();
      failInFlight();
      if (closed) return;
      scheduleReconnect("The connection to the daemon was lost.");
    };
  }

  function scheduleReconnect(detail: string): void {
    if (closed) return;
    publishStatus({ state: "offline", detail });
    // Exponential backoff with jitter: many controllers reconnecting after
    // the same network blip must not arrive together.
    const base = Math.min(DEFAULTS.initialBackoffMs * 2 ** attempt, maxBackoffMs);
    attempt += 1;
    const delay = base / 2 + Math.random() * (base / 2);
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    invoke<C extends HostCommand>(command: C, params: CommandParams<C>): Promise<CommandResponse<CommandResult<C>>> {
      if (closed) {
        return Promise.resolve({ ok: false, error: connectionError("The connection to the daemon is closed.") });
      }
      const id = nextRequestId++;
      const frame: ClientFrame = { kind: "request", id, command, params };
      return new Promise<CommandResponse<CommandResult<C>>>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: connectionError("The daemon did not answer in time.") });
        }, requestTimeoutMs);
        pending.set(id, { resolve: resolve as (response: CommandResponse) => void, timer, frame, sent: false });
        // When the link is down the frame stays queued, unsent, and goes
        // out on the next `welcome`.
        dispatch(id);
      });
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    close() {
      closed = true;
      online = false;
      stopHeartbeat();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      failAll("The connection to the daemon was closed.");
      socket?.close();
      socket = undefined;
    },
  };
}
