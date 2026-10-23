import { JsonFileDocument } from "./json-file.js";
import type { AccountStore } from "@rack/core/accounts/ports";
import type { AccountId, AccountRecord, ProviderId } from "@rack/core/accounts/types";

interface AccountDocument {
  readonly schemaVersion: 1;
  readonly accounts: AccountRecord[];
  readonly selectedByProvider: Record<ProviderId, AccountId>;
}

/** Durable account metadata store. Credential material is never written here. */
export class JsonAccountStore implements AccountStore {
  private readonly document: JsonFileDocument<AccountDocument>;

  constructor(filePath: string) {
    this.document = new JsonFileDocument<AccountDocument>(filePath, {
      schemaVersion: 1,
      accounts: [],
      selectedByProvider: {},
    });
  }

  async list(): Promise<readonly AccountRecord[]> {
    return (await this.document.read()).accounts;
  }

  async get(accountId: AccountId): Promise<AccountRecord | undefined> {
    return (await this.document.read()).accounts.find((account) => account.id === accountId);
  }

  async save(account: AccountRecord): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      accounts: [
        ...current.accounts.filter((candidate) => candidate.id !== account.id),
        account,
      ],
    }));
  }

  async getSelected(providerId: ProviderId): Promise<AccountId | undefined> {
    return (await this.document.read()).selectedByProvider[providerId];
  }

  async setSelected(providerId: ProviderId, accountId: AccountId): Promise<void> {
    await this.document.update((current) => ({
      ...current,
      selectedByProvider: {
        ...current.selectedByProvider,
        [providerId]: accountId,
      },
    }));
  }
}
