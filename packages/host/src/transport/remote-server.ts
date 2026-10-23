/**
 * Serves one `HostApi` to remote controllers over any message-oriented link.
 *
 * This is the transport-independent half of the daemon: it owns the
 * handshake (version check, token check), correlates requests with
 * responses, and drives the replay handshake described in
 * `@rack/contracts/protocol`. The daemon supplies the sockets; a test
 * supplies a fake. Neither changes the rules enforced here.
 *
 * Two properties are worth stating because they are easy to lose:
 *
 * - **A controller is never trusted before `hello` succeeds.** Any other
 *   frame on an unauthenticated connection closes it. Without that, an
 *   unauthorized peer could run commands by skipping the handshake.
 *
 * - **Replay has no gap and no duplicate.** The server subscribes to the
 *   live stream *before* it reads the replay buffer, queues whatever
 *   arrives during the handshake, and then flushes only the part of that
 *   queue the replay did not already cover. Subscribing afterwards would
 *   silently drop any event published in between.
 */
import {
  PROTOCOL_VERSION,
  isClientFrame,
  isProtocolSupported,
  type ClientFrame,
  type ClientHello,
  type HandshakeRejection,
  type SequencedEvent,
} from "@rack/contracts/protocol";
import type { CommandResponse } from "@rack/contracts/transport";

import type { EventStream } from "./event-stream.js";
import type { HostConnection, HostEndpoint } from "./connection.js";

export interface RemoteHostServerOptions {
  /** The command surface being served; `HostApi` satisfies it. */
  readonly endpoint: HostEndpoint;
  /** The sequenced event stream fed by the same host. */
  readonly events: EventStream;
  /** Identifies this machine to controllers, for routing and display. */
  readonly machineId: string;
  /**
   * Identifies this process. It must differ after every restart so a
   * controller can tell that its resume cursor belongs to a dead stream.
   */
  readonly instanceId: string;
  /**
   * Decides whether a pairing token is accepted. The caller owns the
   * comparison so it can be constant-time, and owns token storage so the
   * host never touches secrets at rest.
   */
  readonly authorize: (token: string) => boolean;
  /** Diagnostics sink. Must never receive tokens. */
  readonly onLog?: (message: string) => void;
}

/** A controller that completed the handshake. */
export interface RemoteClient {
  readonly clientId: string;
  readonly remoteAddress?: string | undefined;
  readonly connectedAt: number;
}

export class RemoteHostServer {
  private readonly options: RemoteHostServerOptions;
  private readonly clients = new Map<HostConnection, RemoteClient>();

  constructor(options: RemoteHostServerOptions) {
    this.options = options;
  }

  /** Controllers that are currently authenticated and attached. */
  get connectedClients(): readonly RemoteClient[] {
    return [...this.clients.values()];
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  /**
   * Takes ownership of a freshly opened connection. Returns immediately;
   * the handshake completes on the connection's first message.
   */
  accept(connection: HostConnection): void {
    let unsubscribe: (() => void) | undefined;
    /** Set once `hello` is accepted. Nothing else is served before then. */
    let authenticated = false;
    /** Events seen during the handshake, before the replay decision. */
    let queued: SequencedEvent[] | undefined = [];
    let lastSent = 0;

    const detach = (): void => {
      unsubscribe?.();
      unsubscribe = undefined;
      this.clients.delete(connection);
    };

    const reject = (reason: HandshakeRejection, message: string): void => {
      connection.send({ kind: "rejected", reason, message });
      this.log(`refused ${describe(connection)}: ${reason}`);
      detach();
      connection.close(reason);
    };

    const deliver = (entry: SequencedEvent): void => {
      if (queued !== undefined) {
        queued.push(entry);
        return;
      }
      lastSent = entry.sequence;
      connection.send({ kind: "event", sequence: entry.sequence, event: entry.event });
    };

    connection.onClose(() => {
      const client = this.clients.get(connection);
      detach();
      if (client !== undefined) this.log(`disconnected ${client.clientId}`);
    });

    connection.onMessage((data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(data) as unknown;
      } catch {
        if (!authenticated) return reject("malformed_handshake", "The first frame was not valid JSON.");
        // An established peer that sends garbage is a bug or an attack; in
        // both cases the connection is no longer trustworthy.
        detach();
        connection.close("malformed_frame");
        return;
      }

      if (!isClientFrame(frame)) {
        if (!authenticated) return reject("malformed_handshake", "The first frame was not a valid hello.");
        detach();
        connection.close("malformed_frame");
        return;
      }

      if (!authenticated) {
        if (frame.kind !== "hello") {
          return reject("malformed_handshake", "The connection must open with a hello frame.");
        }
        authenticated = this.completeHandshake(connection, frame, {
          subscribe: (listener) => {
            unsubscribe = this.options.events.subscribe(listener);
          },
          deliver,
          flush: (replayedThrough) => {
            lastSent = replayedThrough;
            const pending = queued ?? [];
            queued = undefined;
            for (const entry of pending) {
              if (entry.sequence <= lastSent) continue;
              lastSent = entry.sequence;
              connection.send({ kind: "event", sequence: entry.sequence, event: entry.event });
            }
          },
          register: (client) => this.clients.set(connection, client),
          reject,
        });
        return;
      }

      this.handle(connection, frame);
    });
  }

  /** Closes every attached controller, for example during shutdown. */
  closeAll(reason: string): void {
    for (const connection of [...this.clients.keys()]) {
      this.clients.delete(connection);
      connection.close(reason);
    }
  }

  private completeHandshake(
    connection: HostConnection,
    hello: ClientHello,
    hooks: {
      subscribe: (listener: (entry: SequencedEvent) => void) => void;
      deliver: (entry: SequencedEvent) => void;
      flush: (replayedThrough: number) => void;
      register: (client: RemoteClient) => void;
      reject: (reason: HandshakeRejection, message: string) => void;
    },
  ): boolean {
    if (!isProtocolSupported(hello.protocolVersion)) {
      hooks.reject(
        "unsupported_protocol",
        `This daemon speaks protocol ${String(PROTOCOL_VERSION)} and cannot serve protocol ${String(hello.protocolVersion)}.`,
      );
      return false;
    }
    if (!this.options.authorize(hello.token)) {
      hooks.reject("unauthorized", "The pairing token was not accepted.");
      return false;
    }

    // Subscribe before reading the buffer so nothing published during the
    // handshake is lost; `deliver` queues until `flush` runs.
    hooks.subscribe(hooks.deliver);

    const replay = hello.resumeFrom === undefined
      ? ({ status: "fresh" } as const)
      : this.options.events.since(hello.resumeFrom);
    const resume = replay.status === "fresh" ? "fresh" : replay.status;
    const replayed = replay.status === "replayed" ? replay.events : [];
    const replayedThrough = replayed.at(-1)?.sequence ?? hello.resumeFrom ?? 0;

    connection.send({
      kind: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      machineId: this.options.machineId,
      instanceId: this.options.instanceId,
      nextSequence: this.options.events.cursor,
      resume,
    });
    for (const entry of replayed) {
      connection.send({ kind: "event", sequence: entry.sequence, event: entry.event });
    }
    hooks.flush(resume === "replayed" ? replayedThrough : 0);

    hooks.register({ clientId: hello.clientId, remoteAddress: connection.remoteAddress, connectedAt: Date.now() });
    this.log(`connected ${hello.clientId} from ${describe(connection)} (resume: ${resume})`);
    return true;
  }

  private handle(connection: HostConnection, frame: ClientFrame): void {
    if (frame.kind === "ping") {
      connection.send({ kind: "pong", id: frame.id });
      return;
    }
    if (frame.kind !== "request") return;
    const { id, command, params } = frame;
    void this.options.endpoint
      .dispatch(command, params)
      .then(
        (response) => connection.send({ kind: "response", id, response }),
        // `dispatch` maps its own failures, so reaching here means the host
        // itself broke. The controller still needs an answer for this ID or
        // its pending call would hang for ever.
        (error: unknown) => connection.send({ kind: "response", id, response: internalFailure(error) }),
      );
  }

  private log(message: string): void {
    this.options.onLog?.(message);
  }
}

function describe(connection: HostConnection): string {
  return connection.remoteAddress ?? "unknown";
}

function internalFailure(error: unknown): CommandResponse {
  return {
    ok: false,
    error: {
      code: "internal",
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
