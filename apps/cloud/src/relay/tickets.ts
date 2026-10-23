/**
 * Relay tickets: short-lived, signed permission for one connection.
 *
 * A relay node forwards bytes between a client and a daemon. It must not need
 * the control plane's database, and it must not be able to mint its own
 * authority. A ticket solves both: the control plane signs a small statement
 * ("this account may reach this daemon, until this instant") and the relay
 * verifies it with a shared secret.
 *
 * The format is a signed payload, not a JWT library: the payload is fixed and
 * small, and algorithm negotiation is the part of JWT that keeps producing
 * vulnerabilities. HMAC-SHA256 over the exact encoded payload, with the
 * algorithm fixed in code, removes that question.
 *
 * Tickets are single use. Replay protection is a separate concern from
 * signing, so `SpentTickets` holds it and the relay node records a redemption
 * before forwarding anything.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "../errors.js";

export interface RelayTicket {
  readonly accountId: string;
  readonly daemonId: string;
  /** Distinguishes two tickets issued in the same millisecond. */
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

/**
 * Tickets are exchanged for a connection immediately after they are issued, so
 * a short life costs nothing and bounds the damage from one that leaks.
 */
export const TICKET_TTL_MS = 60_000;

export function issueTicket(secret: string, input: { accountId: string; daemonId: string }, now: Date, ttlMs = TICKET_TTL_MS): { token: string; ticket: RelayTicket } {
  const ticket: RelayTicket = {
    accountId: input.accountId,
    daemonId: input.daemonId,
    nonce: randomBytes(12).toString("base64url"),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const payload = Buffer.from(JSON.stringify(ticket), "utf8").toString("base64url");
  return { token: `${payload}.${sign(payload, secret)}`, ticket };
}

/**
 * Verifies a ticket's signature and expiry. It deliberately does not consult
 * the registry: a relay node runs this with nothing but the shared secret.
 */
export function verifyTicket(secret: string, token: string, now: Date): RelayTicket {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) throw new UnauthorizedError("malformed relay ticket");
  const payload = token.slice(0, separator);
  const presented = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = Buffer.from(sign(payload, secret), "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new UnauthorizedError("relay ticket signature does not match");
  }
  // Decoding happens only after the signature holds, so malformed input from
  // an unauthenticated caller never reaches the parser.
  const ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RelayTicket;
  if (Date.parse(ticket.expiresAt) <= now.getTime()) throw new UnauthorizedError("relay ticket has expired");
  return ticket;
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

/**
 * Remembers redeemed tickets until they expire, so a captured ticket cannot be
 * used twice. Entries are pruned on insert; the set never holds more than one
 * TTL window of redemptions, which is why no background timer is needed.
 */
export class SpentTickets {
  private readonly spent = new Map<string, number>();

  /** Returns false when the ticket was already redeemed. */
  redeem(ticket: RelayTicket, now: Date): boolean {
    this.prune(now);
    if (this.spent.has(ticket.nonce)) return false;
    this.spent.set(ticket.nonce, Date.parse(ticket.expiresAt));
    return true;
  }

  private prune(now: Date): void {
    for (const [nonce, expiresAt] of this.spent) {
      if (expiresAt <= now.getTime()) this.spent.delete(nonce);
    }
  }
}
