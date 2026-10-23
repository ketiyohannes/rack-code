/**
 * The narrow duplex link `RemoteHostServer` needs from a socket.
 *
 * `@rack/host` deliberately does not depend on a WebSocket implementation.
 * The daemon owns that choice and adapts its sockets to this interface,
 * which keeps the handshake, authorization and replay logic testable with a
 * plain in-memory fake and leaves the host installable in environments that
 * bring their own transport (a Unix socket, a relay, a tsnet listener).
 */
import type { ServerFrame } from "@rack/contracts/protocol";

export interface HostConnection {
  /** Peer address, used only for log lines. */
  readonly remoteAddress?: string | undefined;
  /**
   * Sends one frame. Implementations serialize it; a send that fails because
   * the peer vanished must not throw, since the server treats disconnection
   * as a normal event rather than an error.
   */
  send(frame: ServerFrame): void;
  /** Closes the link. `reason` is for diagnostics, not for the UI. */
  close(reason: string): void;
  /** Registers the sole message listener; `data` is the raw JSON text. */
  onMessage(listener: (data: string) => void): void;
  /** Registers the sole close listener. */
  onClose(listener: () => void): void;
}

/**
 * What the remote server needs from the host. `HostApi` satisfies this
 * structurally, so the transport never imports the command surface it
 * serves and tests can drive it with a two-method fake.
 */
export interface HostEndpoint {
  dispatch(command: unknown, params: unknown): Promise<import("@rack/contracts/transport").CommandResponse>;
  shutdown(timeoutMs: number): Promise<number>;
}
