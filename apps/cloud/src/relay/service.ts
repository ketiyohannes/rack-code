/**
 * Issuing and redeeming relay tickets.
 *
 * Issuing requires an account token and proof that the account owns the
 * daemon; redeeming requires the relay node's own credential, which the HTTP
 * layer checks before calling `redeem`. Splitting the two keeps a client from
 * resolving a daemon's endpoints by replaying its own ticket, and keeps a
 * compromised relay node from issuing itself access to other accounts.
 *
 * The control plane does not carry traffic. It answers where a daemon claims
 * to be reachable and signs permission to be connected to it; the connection
 * itself is between the client, the relay node and the daemon, and the
 * daemon's own pairing token still has to be presented at the far end.
 */
import { ForbiddenError, UnauthorizedError } from "../errors.js";
import { SpentTickets, TICKET_TTL_MS, issueTicket, verifyTicket, type RelayTicket } from "./tickets.js";
import type { RegistryService } from "../registry/service.js";
import type { DaemonView } from "../registry/types.js";

export interface RelayGrant {
  readonly ticket: RelayTicket;
  readonly daemon: DaemonView;
}

export class RelayService {
  private readonly spent = new SpentTickets();

  constructor(
    private readonly registry: RegistryService,
    private readonly signingSecret: string,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = TICKET_TTL_MS,
  ) {}

  /**
   * Issues a ticket for a daemon the account owns. An offline daemon still
   * gets a ticket: liveness is reported from the last heartbeat, which can lag
   * a machine that is in fact reachable, and the connection attempt is the
   * authoritative answer.
   */
  async issue(accountId: string, daemonId: string): Promise<{ token: string; ticket: RelayTicket; daemon: DaemonView }> {
    const daemon = await this.registry.get(accountId, daemonId);
    const issued = issueTicket(this.signingSecret, { accountId, daemonId }, this.now(), this.ttlMs);
    return { ...issued, daemon };
  }

  /**
   * Verifies a ticket presented by a relay node and resolves the endpoints it
   * may connect to. A second redemption of the same ticket is refused, so a
   * ticket observed in transit cannot be reused by an observer.
   */
  async redeem(token: string): Promise<RelayGrant> {
    const now = this.now();
    const ticket = verifyTicket(this.signingSecret, token, now);
    if (!this.spent.redeem(ticket, now)) throw new UnauthorizedError("relay ticket has already been redeemed");
    const daemon = await this.registry.get(ticket.accountId, ticket.daemonId);
    // The registration could have been replaced between issue and redemption.
    if (daemon.accountId !== ticket.accountId) throw new ForbiddenError("the ticket does not match the daemon's owner");
    return { ticket, daemon };
  }
}
