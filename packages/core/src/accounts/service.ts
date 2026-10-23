import { randomUUID } from "node:crypto";

import {
  AccountNotFoundError,
  AccountProviderMismatchError,
  DuplicateAccountError,
  InvalidAccountError,
} from "./errors.js";
import type { AccountStore } from "./ports.js";
import type {
  AccountAvailabilityObservation,
  AccountId,
  AccountRecord,
  ProviderId,
  ReauthenticateAccountInput,
  RegisterAccountInput,
} from "./types.js";

export interface AccountsServiceOptions {
  readonly now?: () => Date;
  readonly createId?: () => string;
}

/**
 * Owns account identity, selection, availability, and switching policy.
 *
 * This service never resolves credentials or starts a provider runtime. It
 * records only opaque references and tells callers which account may be used;
 * authentication and execution remain separate capabilities.
 */
export class AccountsService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly store: AccountStore,
    options: AccountsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  /** Registers one provider identity and rejects duplicate identities. */
  async register(input: RegisterAccountInput): Promise<AccountRecord> {
    validateRegistration(input);

    if (input.credential.providerId !== input.providerId) {
      throw new InvalidAccountError(
        "The credential reference provider must match the account provider.",
      );
    }

    const existing = await this.store.list();
    if (
      existing.some(
        (account) =>
          account.providerId === input.providerId &&
          account.identity.providerAccountId === input.identity.providerAccountId,
      )
    ) {
      throw new DuplicateAccountError(
        input.providerId,
        input.identity.providerAccountId,
      );
    }

    const timestamp = this.now().toISOString();
    const account: AccountRecord = {
      id: input.id ?? this.createId(),
      providerId: input.providerId,
      identity: { ...input.identity },
      credential: { ...input.credential },
      runtimeContextId: input.runtimeContextId,
      availability: input.availability ?? "unknown",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.store.save(account);
    return account;
  }

  /** Lists accounts, optionally restricted to one provider. */
  async list(providerId?: ProviderId): Promise<readonly AccountRecord[]> {
    const accounts = await this.store.list();
    return accounts
      .filter((account) => providerId === undefined || account.providerId === providerId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Returns one account or raises a domain-specific not-found error. */
  async get(accountId: AccountId): Promise<AccountRecord> {
    const account = await this.store.get(accountId);
    if (account === undefined) {
      throw new AccountNotFoundError(accountId);
    }
    return account;
  }

  /** Selects an account for future attempts without changing active attempts. */
  async select(providerId: ProviderId, accountId: AccountId): Promise<AccountRecord> {
    const account = await this.get(accountId);
    if (account.providerId !== providerId) {
      throw new AccountProviderMismatchError(accountId, providerId, account.providerId);
    }

    await this.store.setSelected(providerId, accountId);
    return account;
  }

  /** Returns the explicitly selected account for a provider, if one exists. */
  async selected(providerId: ProviderId): Promise<AccountRecord | undefined> {
    const accountId = await this.store.getSelected(providerId);
    return accountId === undefined ? undefined : this.store.get(accountId);
  }

  /**
   * Replaces an account's opaque credential after authentication succeeds.
   *
   * Authentication itself belongs to the host or an authentication adapter;
   * this method records only the new reference, clears stale availability and
   * quota observations, and leaves active attempts untouched.
   */
  async reauthenticate(
    accountId: AccountId,
    input: ReauthenticateAccountInput,
  ): Promise<AccountRecord> {
    const account = await this.get(accountId);
    if (input.credential.providerId !== account.providerId) {
      throw new InvalidAccountError("The credential reference provider must match the account provider.");
    }
    if (input.credential.id.trim() === "" || input.credential.method.trim() === "") {
      throw new InvalidAccountError("Credential id and method are required.");
    }
    if (input.runtimeContextId !== undefined && input.runtimeContextId.trim() === "") {
      throw new InvalidAccountError("Runtime context id is required when supplied.");
    }
    const {
      availabilityReason: _previousReason,
      quotaResetAt: _previousQuotaResetAt,
      ...accountWithoutObservationDetails
    } = account;
    const updated: AccountRecord = {
      ...accountWithoutObservationDetails,
      credential: { ...input.credential },
      ...(input.runtimeContextId === undefined ? {} : { runtimeContextId: input.runtimeContextId }),
      availability: "unknown",
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Chooses an account for a new attempt.
   *
   * The selected account wins when it is available. If it is unavailable, the
   * service chooses the most recently used available account, then creation
   * order as a deterministic tie-breaker. It never changes an active attempt's
   * account; callers record any returned account as a new attempt decision.
   */
  async chooseEligible(providerId: ProviderId): Promise<AccountRecord | undefined> {
    const accounts = await this.list(providerId);
    const selected = await this.selected(providerId);
    if (selected?.availability === "available") {
      return selected;
    }

    return accounts
      .filter((account) => account.availability === "available")
      .sort((left, right) => {
        const leftUsed = left.lastUsedAt ?? "";
        const rightUsed = right.lastUsedAt ?? "";
        return rightUsed.localeCompare(leftUsed) || left.createdAt.localeCompare(right.createdAt);
      })[0];
  }

  /** Applies a provider observation without exposing provider SDK data. */
  async updateAvailability(
    accountId: AccountId,
    observation: AccountAvailabilityObservation,
  ): Promise<AccountRecord> {
    const account = await this.get(accountId);
    const {
      availabilityReason: _previousReason,
      quotaResetAt: _previousQuotaResetAt,
      ...accountWithoutObservationDetails
    } = account;
    const updated: AccountRecord = {
      ...accountWithoutObservationDetails,
      availability: observation.status,
      updatedAt: observation.observedAt ?? this.now().toISOString(),
      ...(observation.reason === undefined
        ? {}
        : { availabilityReason: observation.reason }),
      ...(observation.quotaResetAt === undefined
        ? {}
        : { quotaResetAt: observation.quotaResetAt }),
    };

    await this.store.save(updated);
    return updated;
  }

  /** Marks the account used by a newly created execution attempt. */
  async markUsed(accountId: AccountId): Promise<AccountRecord> {
    const account = await this.get(accountId);
    const timestamp = this.now().toISOString();
    const updated: AccountRecord = {
      ...account,
      lastUsedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.save(updated);
    return updated;
  }
}

function validateRegistration(input: RegisterAccountInput): void {
  if (input.providerId.trim() === "") {
    throw new InvalidAccountError("Provider id is required.");
  }
  if (input.identity.providerAccountId.trim() === "") {
    throw new InvalidAccountError("Provider account id is required.");
  }
  if (input.credential.id.trim() === "" || input.credential.method.trim() === "") {
    throw new InvalidAccountError("Credential id and method are required.");
  }
  if (input.runtimeContextId.trim() === "") {
    throw new InvalidAccountError("Runtime context id is required.");
  }
}
