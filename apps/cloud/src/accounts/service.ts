/**
 * Sign-up, sign-in, API tokens and the account lookup every other capability
 * uses to resolve a request to a tenant.
 *
 * The service owns identity only. It does not know about plans, machines or
 * daemons; the HTTP layer composes it with billing at sign-up, which keeps
 * the dependency one-directional and the modules separately testable.
 */
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors.js";
import { hashSecret, newId, newSecret } from "../ids.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import type { AccountRecord, AccountsDocument, ApiTokenRecord } from "./types.js";
import type { Document } from "../storage.js";

export interface SignUpRequest {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

export interface IssuedToken {
  readonly record: ApiTokenRecord;
  /** Shown once. Only its digest is stored. */
  readonly secret: string;
}

/**
 * How stale a token's `lastUsedAt` may be before it is rewritten. Recording
 * every request would turn each read into a write; a minute is enough for
 * "which of my tokens is still in use" without that cost.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

export class AccountsService {
  constructor(
    private readonly document: Document<AccountsDocument>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async signUp(request: SignUpRequest): Promise<{ account: AccountRecord; token: IssuedToken }> {
    const password = await hashPassword(request.password);
    const at = this.now().toISOString();
    const account: AccountRecord = {
      id: newId("acc"),
      email: request.email,
      displayName: request.displayName,
      status: "active",
      createdAt: at,
      password,
    };
    // The uniqueness check and the insert share one document update, so two
    // simultaneous sign-ups for the same address cannot both succeed.
    await this.document.update((current) => {
      if (current.accounts.some((existing) => existing.email === account.email)) {
        throw new ConflictError("an account with that email address already exists", { email: account.email });
      }
      return { ...current, accounts: [...current.accounts, account] };
    });
    return { account, token: await this.issueToken(account.id, "initial") };
  }

  /**
   * Verifies a password. An unknown address and a wrong password produce the
   * same error, and an unknown address still pays for a hash comparison, so
   * response timing does not reveal which addresses are registered.
   */
  async signIn(email: string, password: string): Promise<{ account: AccountRecord; token: IssuedToken }> {
    const account = (await this.document.read()).accounts.find((candidate) => candidate.email === email);
    const stored = account?.password ?? (await this.decoyHash());
    const valid = await verifyPassword(password, stored);
    if (account === undefined || !valid) throw new UnauthorizedError();
    this.assertUsable(account);
    return { account, token: await this.issueToken(account.id, "session") };
  }

  /** Resolves a bearer token to its account, rejecting revoked and suspended ones. */
  async authenticate(secret: string): Promise<AccountRecord> {
    const hash = hashSecret(secret);
    const snapshot = await this.document.read();
    const token = snapshot.tokens.find((candidate) => candidate.hash === hash);
    if (token === undefined || token.revokedAt !== undefined) throw new UnauthorizedError("unknown or revoked token");
    const account = snapshot.accounts.find((candidate) => candidate.id === token.accountId);
    if (account === undefined) throw new UnauthorizedError("unknown or revoked token");
    this.assertUsable(account);
    await this.recordUse(token);
    return account;
  }

  async get(accountId: string): Promise<AccountRecord> {
    const account = (await this.document.read()).accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined) throw new NotFoundError("account", accountId);
    return account;
  }

  async issueToken(accountId: string, name: string): Promise<IssuedToken> {
    const generated = newSecret("rck");
    const at = this.now().toISOString();
    const record: ApiTokenRecord = { id: newId("tok"), accountId, name, hash: generated.hash, createdAt: at, lastUsedAt: at };
    await this.document.update((current) => ({ ...current, tokens: [...current.tokens, record] }));
    return { record, secret: generated.secret };
  }

  async listTokens(accountId: string): Promise<readonly ApiTokenRecord[]> {
    return (await this.document.read()).tokens.filter((token) => token.accountId === accountId && token.revokedAt === undefined);
  }

  async revokeToken(accountId: string, tokenId: string): Promise<ApiTokenRecord> {
    const at = this.now().toISOString();
    let revoked: ApiTokenRecord | undefined;
    await this.document.update((current) => {
      const token = current.tokens.find((candidate) => candidate.id === tokenId);
      // Ownership failures answer "not found": whether another account's token
      // ID exists is not this caller's business.
      if (token === undefined || token.accountId !== accountId) throw new NotFoundError("token", tokenId);
      revoked = { ...token, revokedAt: at };
      return { ...current, tokens: current.tokens.map((candidate) => (candidate.id === tokenId ? revoked! : candidate)) };
    });
    if (revoked === undefined) throw new NotFoundError("token", tokenId);
    return revoked;
  }

  /**
   * Suspends an account without deleting it. Billing uses this for accounts
   * that lapse past recovery; the machines stay recorded, because deleting
   * someone's work is a separate, explicit decision.
   */
  async setStatus(accountId: string, status: AccountRecord["status"], reason?: string): Promise<AccountRecord> {
    let updated: AccountRecord | undefined;
    await this.document.update((current) => {
      const account = current.accounts.find((candidate) => candidate.id === accountId);
      if (account === undefined) throw new NotFoundError("account", accountId);
      const { suspendedReason: _previous, ...rest } = account;
      updated = status === "suspended" && reason !== undefined ? { ...rest, status, suspendedReason: reason } : { ...rest, status };
      return { ...current, accounts: current.accounts.map((candidate) => (candidate.id === accountId ? updated! : candidate)) };
    });
    if (updated === undefined) throw new NotFoundError("account", accountId);
    return updated;
  }

  private assertUsable(account: AccountRecord): void {
    if (account.status === "suspended") {
      throw new ForbiddenError(`account is suspended: ${account.suspendedReason ?? "contact support"}`);
    }
  }

  private async recordUse(token: ApiTokenRecord): Promise<void> {
    const at = this.now();
    if (at.getTime() - Date.parse(token.lastUsedAt) < LAST_USED_RESOLUTION_MS) return;
    const stamped = at.toISOString();
    await this.document.update((current) => ({
      ...current,
      tokens: current.tokens.map((candidate) => (candidate.id === token.id ? { ...candidate, lastUsedAt: stamped } : candidate)),
    }));
  }

  /**
   * A throwaway hash with the production parameters, used when no account
   * matches so that both branches of `signIn` do the same work.
   */
  private decoyHash(): Promise<AccountRecord["password"]> {
    this.decoy ??= hashPassword("no-account-with-this-address");
    return this.decoy;
  }

  private decoy: Promise<AccountRecord["password"]> | undefined;
}
