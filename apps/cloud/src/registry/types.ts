/**
 * The daemon registry: how a client finds the daemon that owns its work.
 *
 * A daemon (`apps/daemon`) runs inside a project machine and authenticates the
 * *device* with its own pairing token. The control plane authenticates
 * *people*. The registry is the join between the two: an account registers the
 * daemons it owns, and a client that signed in as that account learns where
 * they can be reached.
 *
 * A registration is evidence that a daemon announced itself, never evidence
 * that it is reachable now. `status` is therefore computed from the last
 * heartbeat at read time rather than stored, so a daemon whose machine was
 * destroyed cannot leave an `online` row behind.
 */

export interface DaemonRecord {
  readonly id: string;
  readonly accountId: string;
  /** The machine assignment this daemon runs in, when it was provisioned here. */
  readonly assignmentId?: string;
  /** Account-scoped name; re-registering under the same name replaces the entry. */
  readonly name: string;
  readonly version: string;
  /** Addresses a client may try, most specific first (tailnet, relay, direct). */
  readonly endpoints: readonly string[];
  /**
   * The daemon's public key or certificate fingerprint, stored opaquely. The
   * control plane does not verify connections; it publishes the key so a
   * client can pin it and detect a relay that swaps the far end.
   */
  readonly publicKey: string;
  /** Digest of the secret the daemon presents when it heartbeats. */
  readonly secretHash: string;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

export interface RegistryDocument {
  readonly schema: 1;
  readonly daemons: readonly DaemonRecord[];
}

export const EMPTY_REGISTRY_DOCUMENT: RegistryDocument = { schema: 1, daemons: [] };

export type DaemonStatus = "online" | "offline";

/** What clients see: locations and liveness, never the heartbeat secret. */
export interface DaemonView {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly version: string;
  readonly endpoints: readonly string[];
  readonly publicKey: string;
  readonly assignmentId?: string;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
  readonly status: DaemonStatus;
}

/**
 * A daemon is considered offline after three missed minute-long heartbeats.
 * The window is generous because a client that tries a stale endpoint simply
 * fails to connect, while a daemon wrongly marked offline is invisible.
 */
export const HEARTBEAT_TIMEOUT_MS = 3 * 60_000;

export function toDaemonView(daemon: DaemonRecord, now: Date): DaemonView {
  const status: DaemonStatus = now.getTime() - Date.parse(daemon.lastSeenAt) <= HEARTBEAT_TIMEOUT_MS ? "online" : "offline";
  const base = {
    id: daemon.id,
    accountId: daemon.accountId,
    name: daemon.name,
    version: daemon.version,
    endpoints: daemon.endpoints,
    publicKey: daemon.publicKey,
    registeredAt: daemon.registeredAt,
    lastSeenAt: daemon.lastSeenAt,
    status,
  };
  return daemon.assignmentId === undefined ? base : { ...base, assignmentId: daemon.assignmentId };
}
