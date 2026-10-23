/**
 * Provider sign-in boundary owned by the Connections capability.
 *
 * An `AccountConnector` runs one provider's interactive sign-in inside an
 * account-specific runtime-context directory and reports progress as
 * provider-neutral events. The provider stores the resulting credential in
 * its own store scoped to that directory (for example `auth.json` under
 * `CODEX_HOME`, or the Keychain entry keyed to `CLAUDE_CONFIG_DIR`), so
 * credential material never passes through application code or records.
 */

/** Identity reported by a provider after a successful sign-in. */
export interface ConnectedIdentity {
  /** Stable provider-side identifier used for duplicate detection. */
  readonly providerAccountId: string;
  readonly email?: string;
  readonly displayName?: string;
  /** Subscription or plan label when the provider reports one. */
  readonly plan?: string;
}

export type ConnectEvent =
  /**
   * The user should complete sign-in at `url` in a browser. `opened` is true
   * when the provider already opened the page itself, so clients should only
   * offer the link rather than open it again.
   */
  | { readonly type: "browser"; readonly url: string; readonly opened: boolean }
  /** Device-code flow: open `url` and enter `code`. */
  | { readonly type: "device_code"; readonly url: string; readonly code: string }
  /** The provider asks the user to paste an authorization code. */
  | { readonly type: "code_required" }
  | { readonly type: "completed"; readonly identity: ConnectedIdentity }
  | { readonly type: "failed"; readonly error: string };

/** One running sign-in. `events` ends after `completed` or `failed`. */
export interface ConnectAttempt {
  readonly events: AsyncIterable<ConnectEvent>;
  /** Supplies a pasted authorization code when `code_required` was emitted. */
  submitCode(code: string): void;
  /** Stops the sign-in and releases provider processes. Idempotent. */
  cancel(): Promise<void>;
}

/** Native directory and environment, either private or explicitly linked. */
export interface ConnectContext {
  readonly runtimeContextId: string;
  readonly directory: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface AccountConnector {
  /** Provider namespace written to the account record, such as `codex`. */
  readonly providerId: string;
  /** Human-readable provider name for "Connect <name> account". */
  readonly displayName: string;
  /** Opaque context for explicitly reusing a provider's existing local login. */
  readonly existingRuntimeContextId?: string;
  connect(context: ConnectContext): ConnectAttempt;
  /** Read-only local readiness check; omitted context checks installation only.
   * Implementations bound process lifetime and return only display-safe fields.
   * No login, model turn, account mutation or credential material is permitted.
   */
  diagnose?(context?: ConnectContext): Promise<ProviderDiagnostic>;
}

/** Point-in-time local observation, not a guarantee of subscription/network access. */
export interface ProviderDiagnostic {
  readonly status: "ready" | "failed";
  readonly stage: "discovery" | "version" | "startup" | "authentication";
  readonly message: string;
  readonly executable?: string;
  readonly version?: string;
  readonly authentication: "signed_in" | "signed_out" | "not_checked";
  readonly checkedAt: string;
}
