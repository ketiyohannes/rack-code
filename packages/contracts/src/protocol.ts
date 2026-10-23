/**
 * Remote protocol between a controller (desktop, web, mobile) and a daemon
 * that hosts Rack on some other machine.
 *
 * The in-process desktop hops in `transport.ts` can assume both ends ship
 * together and that no message is ever lost. Neither holds here: a phone and
 * a VPS daemon update on their own schedules, and a laptop lid closing drops
 * the socket mid-run. This module therefore adds the two things the local
 * envelopes do not need.
 *
 * **Version negotiation.** Every connection opens with `hello`/`welcome`
 * carrying `PROTOCOL_VERSION`. A daemon that cannot speak the controller's
 * version says so in a `rejected` frame instead of failing later on a field
 * it does not understand.
 *
 * **Resumable event streams.** The daemon stamps every `HostEvent` with a
 * monotonic `sequence` and keeps a bounded tail of recent events. A
 * controller records the highest sequence it has applied and asks to resume
 * from it. When the gap is still buffered the daemon replays it and the
 * controller keeps its state; when it is not, the daemon says the stream was
 * truncated and the controller re-reads state with the ordinary read
 * commands. That fallback is always correct because host events are a
 * freshness signal rather than the source of truth (see `events.ts`), so
 * buffering is an optimization and never a correctness requirement.
 *
 * Nothing here performs I/O or assumes a particular socket library; both
 * ends exchange these frames as JSON.
 */
import type { HostCommand } from "./commands.js";
import type { HostErrorPayload } from "./errors.js";
import type { HostEvent } from "./events.js";
import type { CommandResponse } from "./transport.js";

/**
 * Wire format version. Bump this on any change that an older peer could
 * misread; purely additive optional fields do not need a bump, because both
 * `hello` and `welcome` are parsed leniently.
 */
export const PROTOCOL_VERSION = 1;

/**
 * Versions a peer at `PROTOCOL_VERSION` still understands. Kept explicit so
 * dropping support for an old controller is a deliberate edit rather than an
 * accident of comparison logic.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/** Why a daemon refused a connection. Controllers branch on this. */
export type HandshakeRejection =
  /** The controller's protocol version is not in `SUPPORTED_PROTOCOL_VERSIONS`. */
  | "unsupported_protocol"
  /** The pairing token was missing, malformed or wrong. */
  | "unauthorized"
  /** The first frame was not a well-formed `hello`. */
  | "malformed_handshake";

/** First frame a controller sends; the daemon answers `welcome` or `rejected`. */
export interface ClientHello {
  readonly kind: "hello";
  readonly protocolVersion: number;
  /** Pairing token for this device. See `docs/architecture.md` on pairing. */
  readonly token: string;
  /**
   * Stable per-installation identifier, used only for logging and for
   * telling a user's devices apart in the daemon's connection list.
   */
  readonly clientId: string;
  /**
   * Highest event sequence this controller has already applied. Omitted on a
   * first connection. The daemon replays everything after it when it can.
   */
  readonly resumeFrom?: number;
}

/** Controller to daemon. */
export type ClientFrame =
  | ClientHello
  /** A host command; answered by exactly one `response` with the same `id`. */
  | { readonly kind: "request"; readonly id: number; readonly command: HostCommand; readonly params: unknown }
  /**
   * Liveness probe. TCP alone can take minutes to notice a dropped link, and
   * a controller that believes it is connected shows stale runs.
   */
  | { readonly kind: "ping"; readonly id: number };

/** Daemon to controller. */
export type ServerFrame =
  | ServerWelcome
  | { readonly kind: "rejected"; readonly reason: HandshakeRejection; readonly message: string }
  | { readonly kind: "response"; readonly id: number; readonly response: CommandResponse }
  /** One host event. `sequence` is monotonic for the life of the daemon process. */
  | { readonly kind: "event"; readonly sequence: number; readonly event: HostEvent }
  | { readonly kind: "pong"; readonly id: number };

export interface ServerWelcome {
  readonly kind: "welcome";
  readonly protocolVersion: number;
  /** Identifies the machine the daemon runs on, for routing and display. */
  readonly machineId: string;
  /**
   * Changes whenever the daemon restarts. A controller that sees a new
   * value knows its buffered sequence numbers refer to a dead stream.
   */
  readonly instanceId: string;
  /** Sequence the next event will carry; also the resume cursor floor. */
  readonly nextSequence: number;
  /**
   * How the daemon answered a `resumeFrom`:
   * - `fresh`: no resume was requested, so the controller starts clean;
   * - `replayed`: the requested gap was buffered and follows as `event` frames;
   * - `truncated`: the gap is gone (or belongs to an earlier instance). The
   *   controller must re-read state with the ordinary read commands.
   */
  readonly resume: "fresh" | "replayed" | "truncated";
}

/** An event paired with the sequence the daemon assigned it. */
export interface SequencedEvent {
  readonly sequence: number;
  readonly event: HostEvent;
}

/** Narrows an unvalidated parsed frame; the daemon must not trust the socket. */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { kind?: unknown; id?: unknown };
  switch (frame.kind) {
    case "hello":
      return isClientHello(value);
    case "request": {
      const request = value as { id?: unknown; command?: unknown };
      return typeof request.id === "number" && typeof request.command === "string";
    }
    case "ping":
      return typeof frame.id === "number";
    default:
      return false;
  }
}

/**
 * Validates the handshake specifically, so a daemon can answer a malformed
 * first frame with `malformed_handshake` rather than dropping the socket.
 */
export function isClientHello(value: unknown): value is ClientHello {
  if (typeof value !== "object" || value === null) return false;
  const hello = value as Partial<ClientHello> & { kind?: unknown };
  return (
    hello.kind === "hello" &&
    typeof hello.protocolVersion === "number" &&
    typeof hello.token === "string" &&
    typeof hello.clientId === "string" &&
    (hello.resumeFrom === undefined || typeof hello.resumeFrom === "number")
  );
}

/** Narrows a parsed frame on the controller side. */
export function isServerFrame(value: unknown): value is ServerFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { kind?: unknown };
  return (
    frame.kind === "welcome" ||
    frame.kind === "rejected" ||
    frame.kind === "response" ||
    frame.kind === "event" ||
    frame.kind === "pong"
  );
}

export function isProtocolSupported(version: number): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}

/**
 * Error a controller surfaces when the connection itself failed, as opposed
 * to a command the host refused. It reuses `host_unavailable` so existing
 * UI paths that already handle an offline local host handle a dropped remote
 * daemon too.
 */
export function connectionError(message: string): HostErrorPayload {
  return { code: "host_unavailable", name: "HostConnectionError", message };
}
