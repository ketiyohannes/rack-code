import assert from "node:assert/strict";
import test from "node:test";
import { SpentTickets, TICKET_TTL_MS, issueTicket, verifyTicket } from "./tickets.js";
import { UnauthorizedError } from "../errors.js";

const SECRET = "relay-signing-secret-0123456789ab";
const START = new Date("2026-10-23T10:00:00.000Z");

test("a ticket carries its subject and is verifiable without the database", () => {
  const { token, ticket } = issueTicket(SECRET, { accountId: "acc_1", daemonId: "dmn_1" }, START);
  const verified = verifyTicket(SECRET, token, START);
  assert.deepEqual(verified, ticket);
  assert.equal(Date.parse(ticket.expiresAt) - START.getTime(), TICKET_TTL_MS);
});

test("a ticket is rejected when it is altered, signed with another key, or expired", () => {
  const { token, ticket } = issueTicket(SECRET, { accountId: "acc_1", daemonId: "dmn_1" }, START);
  assert.throws(() => verifyTicket("another-signing-secret-0123456789", token, START), UnauthorizedError);

  // Swapping the payload for one naming a different daemon invalidates the
  // signature, so a client cannot widen its own ticket.
  const forged = Buffer.from(JSON.stringify({ ...ticket, daemonId: "dmn_other" }), "utf8").toString("base64url");
  assert.throws(() => verifyTicket(SECRET, `${forged}.${token.slice(token.lastIndexOf(".") + 1)}`, START), UnauthorizedError);
  assert.throws(() => verifyTicket(SECRET, "not-a-ticket", START), UnauthorizedError);
  assert.throws(() => verifyTicket(SECRET, token, new Date(Date.parse(ticket.expiresAt) + 1)), UnauthorizedError);
});

test("a ticket can be redeemed once, and spent nonces do not accumulate", () => {
  const spent = new SpentTickets();
  const first = issueTicket(SECRET, { accountId: "acc_1", daemonId: "dmn_1" }, START).ticket;
  assert.equal(spent.redeem(first, START), true);
  assert.equal(spent.redeem(first, START), false, "a ticket observed in transit cannot be reused");

  const second = issueTicket(SECRET, { accountId: "acc_1", daemonId: "dmn_1" }, START).ticket;
  assert.equal(spent.redeem(second, START), true, "each issue is independent");

  // After the window passes, the record of a spent ticket is no longer needed:
  // the ticket itself would fail verification on expiry.
  const later = new Date(Date.parse(first.expiresAt) + 1);
  const third = issueTicket(SECRET, { accountId: "acc_1", daemonId: "dmn_1" }, later).ticket;
  assert.equal(spent.redeem(third, later), true);
  assert.equal(spent.redeem(first, later), true, "the pruned nonce is free again, but the ticket holding it has expired");
});
