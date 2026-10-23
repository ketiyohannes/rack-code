import type { AccountId, AccountRecord, ProviderId } from "./types.js";

/**
 * Persistence boundary owned by Accounts.
 *
 * Implementations may later use SQLite or another store. The account service
 * owns validation and selection policy, while the store only persists records
 * and the selected account per provider.
 */
export interface AccountStore {
  list(): Promise<readonly AccountRecord[]>;
  get(accountId: AccountId): Promise<AccountRecord | undefined>;
  save(account: AccountRecord): Promise<void>;
  getSelected(providerId: ProviderId): Promise<AccountId | undefined>;
  setSelected(providerId: ProviderId, accountId: AccountId): Promise<void>;
}
