/**
 * Account identity and the credentials that prove it.
 *
 * Accounts are the only tenant identity in the control plane: every machine,
 * daemon registration and subscription is owned by exactly one account ID.
 * Credentials are never stored in a recoverable form — passwords as scrypt
 * hashes, API tokens as digests — so a copy of this document does not let the
 * holder sign in.
 */

export type AccountStatus = "active" | "suspended";

export interface PasswordHash {
  readonly algorithm: "scrypt";
  readonly salt: string;
  readonly hash: string;
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly keyLength: number;
}

export interface AccountRecord {
  readonly id: string;
  /** Normalized (trimmed, lower-cased); unique across accounts. */
  readonly email: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly createdAt: string;
  readonly password: PasswordHash;
  /** Why an account was suspended, shown to the account holder. */
  readonly suspendedReason?: string;
}

/**
 * A bearer credential. Several may exist per account (a desktop app, a daemon
 * bootstrap, CI), so one can be revoked without signing every device out.
 */
export interface ApiTokenRecord {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly hash: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly revokedAt?: string;
}

export interface AccountsDocument {
  readonly schema: 1;
  readonly accounts: readonly AccountRecord[];
  readonly tokens: readonly ApiTokenRecord[];
}

export const EMPTY_ACCOUNTS_DOCUMENT: AccountsDocument = { schema: 1, accounts: [], tokens: [] };

/** The account view returned to clients: identity without credential material. */
export interface AccountView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly status: AccountStatus;
  readonly createdAt: string;
}

export function toAccountView(account: AccountRecord): AccountView {
  return { id: account.id, email: account.email, displayName: account.displayName, status: account.status, createdAt: account.createdAt };
}
