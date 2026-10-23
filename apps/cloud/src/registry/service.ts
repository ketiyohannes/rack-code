/**
 * Registration, heartbeats and account-scoped lookup.
 *
 * Every read is scoped to one account. Discovery across accounts is not a
 * feature with an access check bolted on; it does not exist, so a daemon ID
 * leaked from one tenant resolves to nothing for another.
 */
import { NotFoundError, UnauthorizedError } from "../errors.js";
import { newId, newSecret, secretMatches } from "../ids.js";
import { toDaemonView, type DaemonRecord, type DaemonView, type RegistryDocument } from "./types.js";
import type { Document } from "../storage.js";

export interface RegistrationRequest {
  readonly name: string;
  readonly version: string;
  readonly endpoints: readonly string[];
  readonly publicKey: string;
  readonly assignmentId?: string;
}

export class RegistryService {
  constructor(
    private readonly document: Document<RegistryDocument>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Registers a daemon, or replaces an existing registration with the same
   * account-scoped name. Re-registration happens after a restore or a
   * reinstall, so it rotates the heartbeat secret: the returned value is the
   * only one that will be accepted afterwards, and a copy taken from the
   * previous machine stops working.
   */
  async register(accountId: string, request: RegistrationRequest): Promise<{ daemon: DaemonView; secret: string }> {
    const generated = newSecret("dmn");
    const at = this.now().toISOString();
    let stored: DaemonRecord | undefined;
    await this.document.update((current) => {
      const previous = current.daemons.find((candidate) => candidate.accountId === accountId && candidate.name === request.name);
      const base = {
        id: previous?.id ?? newId("dmn"),
        accountId,
        name: request.name,
        version: request.version,
        endpoints: request.endpoints,
        publicKey: request.publicKey,
        secretHash: generated.hash,
        registeredAt: previous?.registeredAt ?? at,
        lastSeenAt: at,
      };
      stored = request.assignmentId === undefined ? base : { ...base, assignmentId: request.assignmentId };
      return {
        ...current,
        daemons: [...current.daemons.filter((candidate) => candidate.id !== stored!.id), stored!],
      };
    });
    if (stored === undefined) throw new NotFoundError("daemon", request.name);
    return { daemon: toDaemonView(stored, this.now()), secret: generated.secret };
  }

  /**
   * Records liveness. The secret proves the caller is the registered daemon;
   * an account token is not accepted here, so a leaked client token cannot
   * make a dead machine look alive. Endpoints may change with each heartbeat,
   * which is how a daemon reports a new relay or tailnet address.
   */
  async heartbeat(daemonId: string, secret: string, update: { readonly endpoints?: readonly string[]; readonly version?: string } = {}): Promise<DaemonView> {
    const at = this.now().toISOString();
    let updated: DaemonRecord | undefined;
    await this.document.update((current) => {
      const daemon = current.daemons.find((candidate) => candidate.id === daemonId);
      if (daemon === undefined || !secretMatches(secret, daemon.secretHash)) {
        throw new UnauthorizedError("unknown daemon or heartbeat secret");
      }
      updated = {
        ...daemon,
        lastSeenAt: at,
        endpoints: update.endpoints ?? daemon.endpoints,
        version: update.version ?? daemon.version,
      };
      return { ...current, daemons: current.daemons.map((candidate) => (candidate.id === daemonId ? updated! : candidate)) };
    });
    if (updated === undefined) throw new UnauthorizedError("unknown daemon or heartbeat secret");
    return toDaemonView(updated, this.now());
  }

  async list(accountId: string): Promise<readonly DaemonView[]> {
    const now = this.now();
    return (await this.document.read()).daemons
      .filter((daemon) => daemon.accountId === accountId)
      .map((daemon) => toDaemonView(daemon, now));
  }

  async get(accountId: string, daemonId: string): Promise<DaemonView> {
    const daemon = (await this.document.read()).daemons.find((candidate) => candidate.id === daemonId);
    if (daemon === undefined || daemon.accountId !== accountId) throw new NotFoundError("daemon", daemonId);
    return toDaemonView(daemon, this.now());
  }

  async deregister(accountId: string, daemonId: string): Promise<void> {
    await this.get(accountId, daemonId);
    await this.document.update((current) => ({ ...current, daemons: current.daemons.filter((candidate) => candidate.id !== daemonId) }));
  }
}
