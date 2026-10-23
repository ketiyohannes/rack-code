import type {
  CredentialMaterial,
  CredentialResolver,
} from "@rack/core/authentication/contracts";
import type { CredentialReference } from "@rack/core/authentication";
import { NATIVE_LOGIN_METHOD } from "@rack/core/connections/service";

/**
 * Resolves credentials for accounts connected through a provider sign-in.
 *
 * A `native_login` reference means the provider keeps the credential in its
 * own store scoped to the account's runtime-context directory (`CODEX_HOME`
 * or `CLAUDE_CONFIG_DIR`). Runtime adapters already point the provider at
 * that directory, so no environment values are needed: the resolver returns
 * an empty environment and the secret never enters this process.
 *
 * Any other method is delegated to `fallback`, for example the in-memory
 * resolver used by tests and embedders that supply tokens directly.
 */
export class NativeLoginCredentialResolver implements CredentialResolver {
  constructor(private readonly fallback: CredentialResolver) {}

  async resolve(reference: CredentialReference): Promise<CredentialMaterial> {
    if (reference.method === NATIVE_LOGIN_METHOD) {
      return { environment: {} };
    }
    return this.fallback.resolve(reference);
  }
}
