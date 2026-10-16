/**
 * Connections: the "Connect <provider> account" workflow.
 *
 * This coordinator sits above Accounts and Authentication and calls only
 * their public interfaces:
 *
 * 1. Allocate a fresh runtime-context ID and resolve its private directory
 *    through the `RuntimeContextResolver`.
 * 2. Run the provider's `AccountConnector` in that directory. The provider
 *    keeps the credential in its own store scoped to the directory.
 * 3. On success, record the account with an opaque credential reference
 *    whose method is `NATIVE_LOGIN_METHOD`, meaning "the provider's own login
 *    in this runtime context". Credential material never reaches Accounts.
 *
 * Duplicate and reconnect handling:
 * - If the signed-in identity matches an existing account of the provider,
 *   that account is re-authenticated onto the new context (its old context
 *   is left on disk because an active attempt may still use it).
 * - Otherwise a new account is registered. It is selected when the provider
 *   has no selected account yet.
 * - A successful sign-in is an availability observation, so the account is
 *   marked `available`.
 *
 * Progress is reported to `subscribe`d observers; the workflow completes
 * without any.
 */
import { randomUUID } from "node:crypto";

import { AccountProviderMismatchError } from "../accounts/errors.js";
import type { AccountsService } from "../accounts/service.js";
import type { AccountRecord } from "../accounts/types.js";
import type { RuntimeContextResolver } from "../authentication/contracts.js";
import { ConnectNotFoundError, ConnectorNotFoundError } from "./errors.js";
import type { AccountConnector, ConnectAttempt, ConnectedIdentity, ProviderDiagnostic } from "./ports.js";
import type { ConnectStatus, ConnectView } from "./types.js";

/** Credential method for logins stored by the provider in the runtime context. */
export const NATIVE_LOGIN_METHOD = "native_login";

export interface ConnectionsServiceOptions {
  readonly createId?: () => string;
}

interface Running {
  view: ConnectView;
  readonly attempt: ConnectAttempt;
}

export class ConnectionsService {
  private readonly diagnostics = new Map<string, Promise<ProviderDiagnostic>>();

  /** Validate ownership before resolving an account context. Concurrent checks
   * share one process sequence; results never alter selection or availability.
   */
  async diagnose(input: { providerId: string; accountId?: string }): Promise<ProviderDiagnostic> {
    const connector = this.connectors.get(input.providerId);
    if (connector === undefined) throw new ConnectorNotFoundError(input.providerId);
    const account = input.accountId === undefined ? undefined : await this.accounts.get(input.accountId);
    if (account !== undefined && account.providerId !== input.providerId) {
      throw new AccountProviderMismatchError(account.id, input.providerId, account.providerId);
    }
    const key = JSON.stringify([input.providerId, account?.runtimeContextId]);
    const existing = this.diagnostics.get(key);
    if (existing !== undefined) return existing;
    const check = (async (): Promise<ProviderDiagnostic> => {
      if (connector.diagnose === undefined) return {
        status: "failed", stage: "discovery", authentication: "not_checked",
        message: "This provider does not support connection checks.", checkedAt: new Date().toISOString(),
      };
      const context = account === undefined ? undefined : {
        ...await this.contexts.resolve(account.runtimeContextId), runtimeContextId: account.runtimeContextId,
      };
      return connector.diagnose(context);
    })();
    this.diagnostics.set(key, check);
    try { return await check; } finally { this.diagnostics.delete(key); }
  }
  private readonly connectors = new Map<string, AccountConnector>();
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<(view: ConnectView) => void>();
  private readonly createId: () => string;

  constructor(
    private readonly accounts: AccountsService,
    private readonly contexts: RuntimeContextResolver,
    connectors: readonly AccountConnector[],
    options: ConnectionsServiceOptions = {},
  ) {
    for (const connector of connectors) {
      this.connectors.set(connector.providerId, connector);
    }
    this.createId = options.createId ?? randomUUID;
  }

  /** Observes every change to every sign-in; returns an unsubscribe function. */
  subscribe(listener: (view: ConnectView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Providers that offer an interactive sign-in. */
  providers(): readonly { readonly providerId: string; readonly displayName: string }[] {
    return [...this.connectors.values()].map(({ providerId, displayName }) => ({ providerId, displayName }));
  }

  /** Sign-ins currently in progress, for clients that (re)connect mid-flow. */
  active(): readonly ConnectView[] {
    return [...this.running.values()].map((running) => running.view);
  }

  /**
   * Starts a sign-in. Returns as soon as the provider process is launched;
   * progress and the outcome arrive through `onUpdate`.
   */
  async connect(input: { readonly providerId: string; readonly accountId?: string }): Promise<ConnectView> {
    const connector = this.connectors.get(input.providerId);
    if (connector === undefined) {
      throw new ConnectorNotFoundError(input.providerId);
    }
    if (input.accountId !== undefined) {
      // Validates that the target exists and belongs to this provider.
      const target = await this.accounts.get(input.accountId);
      if (target.providerId !== input.providerId) {
        throw new AccountProviderMismatchError(target.id, input.providerId, target.providerId);
      }
    }

    const connectId = this.createId();
    const runtimeContextId = `ctx-${this.createId()}`;
    const context = await this.contexts.resolve(runtimeContextId);
    const attempt = connector.connect({
      runtimeContextId,
      directory: context.directory,
      ...(context.environment === undefined ? {} : { environment: context.environment }),
    });
    const running: Running = {
      attempt,
      view: {
        connectId,
        providerId: input.providerId,
        ...(input.accountId === undefined ? {} : { targetAccountId: input.accountId }),
        status: "waiting",
        needsCode: false,
      },
    };
    this.running.set(connectId, running);
    this.emit(running.view);
    void this.follow(running, runtimeContextId);
    return running.view;
  }

  submitCode(connectId: string, code: string): void {
    this.require(connectId).attempt.submitCode(code);
  }

  async cancel(connectId: string): Promise<void> {
    const running = this.require(connectId);
    this.finish(running, { status: "cancelled" });
    await running.attempt.cancel();
  }

  /** Cancels every sign-in; used when the host shuts down. */
  async cancelAll(): Promise<void> {
    await Promise.allSettled([...this.running.keys()].map((connectId) => this.cancel(connectId)));
  }

  private require(connectId: string): Running {
    const running = this.running.get(connectId);
    if (running === undefined) {
      throw new ConnectNotFoundError(connectId);
    }
    return running;
  }

  private async follow(running: Running, runtimeContextId: string): Promise<void> {
    try {
      for await (const event of running.attempt.events) {
        if (!this.running.has(running.view.connectId)) return;
        if (event.type === "browser") {
          this.update(running, { url: event.url, urlOpenedByProvider: event.opened });
        } else if (event.type === "device_code") {
          this.update(running, { url: event.url, userCode: event.code });
        } else if (event.type === "code_required") {
          this.update(running, { needsCode: true });
        } else if (event.type === "failed") {
          this.finish(running, { status: "failed", error: event.error });
          return;
        } else if (event.type === "completed") {
          const outcome = await this.record(running.view, event.identity, runtimeContextId);
          this.finish(running, { status: "completed", ...outcome });
          return;
        }
      }
      // The provider stopped without reporting an outcome.
      this.finish(running, { status: "failed", error: "Sign-in ended without a result." });
    } catch (error) {
      this.finish(running, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      await running.attempt.cancel().catch(() => undefined);
    }
  }

  /**
   * Records the signed-in identity. Matching is by provider and provider
   * account ID; a reconnect that signed in as someone else becomes a new or
   * matched account and is flagged as `identityChanged`.
   */
  private async record(
    view: ConnectView,
    identity: ConnectedIdentity,
    runtimeContextId: string,
  ): Promise<Pick<ConnectView, "accountId" | "reconnected" | "identityChanged">> {
    const credential = { id: view.connectId, providerId: view.providerId, method: NATIVE_LOGIN_METHOD };
    const existing = (await this.accounts.list(view.providerId))
      .find((account) => account.identity.providerAccountId === identity.providerAccountId);
    const identityChanged = view.targetAccountId !== undefined && existing?.id !== view.targetAccountId;

    let account: AccountRecord;
    if (existing !== undefined) {
      account = await this.accounts.reauthenticate(existing.id, { credential, runtimeContextId });
    } else {
      account = await this.accounts.register({
        providerId: view.providerId,
        identity: {
          providerAccountId: identity.providerAccountId,
          ...(identity.email === undefined ? {} : { email: identity.email }),
          ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
        },
        credential,
        runtimeContextId,
      });
      if ((await this.accounts.selected(view.providerId)) === undefined) {
        await this.accounts.select(view.providerId, account.id);
      }
    }
    await this.accounts.updateAvailability(account.id, {
      status: "available",
      ...(identity.plan === undefined ? {} : { reason: `Signed in (${identity.plan})` }),
    });
    return { accountId: account.id, reconnected: existing !== undefined, ...(identityChanged ? { identityChanged } : {}) };
  }

  private emit(view: ConnectView): void {
    for (const listener of this.listeners) listener(view);
  }

  private update(running: Running, patch: Partial<ConnectView>): void {
    running.view = { ...running.view, ...patch };
    this.emit(running.view);
  }

  private finish(running: Running, patch: Partial<ConnectView> & { status: ConnectStatus }): void {
    if (!this.running.has(running.view.connectId)) return;
    this.running.delete(running.view.connectId);
    this.update(running, { ...patch, needsCode: false });
  }
}
