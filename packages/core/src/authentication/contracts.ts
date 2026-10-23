import type { CredentialReference } from "./index.js";

/**
 * Authentication material resolved only inside a provider adapter.
 *
 * This type is intentionally not imported by Accounts or Execution. An
 * adapter receives it after selecting an account and uses it only to launch
 * the provider process; it must never persist it in application records.
 */
export type CredentialMaterial = {
  readonly environment: Readonly<Record<string, string>>;
};

export interface CredentialResolver {
  resolve(reference: CredentialReference): Promise<CredentialMaterial>;
}

/** Runtime-specific directory and environment isolation for one account. */
export interface RuntimeContextResolver {
  resolve(runtimeContextId: string): Promise<{
    readonly directory: string;
    readonly environment?: Readonly<Record<string, string>>;
  }>;
}
