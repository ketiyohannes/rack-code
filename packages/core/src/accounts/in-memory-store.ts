import type { AccountStore } from "./ports.js";
import type { AccountId, AccountRecord, ProviderId } from "./types.js";

/**
 * Deterministic store for headless tests and early composition.
 *
 * It clones records at every boundary so callers cannot mutate account state
 * without going through the Accounts service. A durable adapter can replace
 * this class without changing the account policy.
 */
export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<AccountId, AccountRecord>();
  private readonly selected = new Map<ProviderId, AccountId>();

  async list(): Promise<readonly AccountRecord[]> {
    return [...this.accounts.values()].map((account) => cloneAccount(account));
  }

  async get(accountId: AccountId): Promise<AccountRecord | undefined> {
    const account = this.accounts.get(accountId);
    return account === undefined ? undefined : cloneAccount(account);
  }

  async save(account: AccountRecord): Promise<void> {
    this.accounts.set(account.id, cloneAccount(account));
  }

  async getSelected(providerId: ProviderId): Promise<AccountId | undefined> {
    return this.selected.get(providerId);
  }

  async setSelected(providerId: ProviderId, accountId: AccountId): Promise<void> {
    this.selected.set(providerId, accountId);
  }
}

function cloneAccount(account: AccountRecord): AccountRecord {
  return {
    ...account,
    identity: { ...account.identity },
    credential: { ...account.credential },
  };
}
