# Accounts capability

Status: initial domain implementation, 2026-10-12.

The Accounts capability owns saved provider identities, account availability, per-provider selection, and account-switching policy. It does not authenticate users, resolve secrets, start agent runtimes, or read provider SDK objects.

## Account boundary

An account record stores:

- An application account ID and provider namespace.
- Safe provider identity information, such as a provider-side account ID, email, or display name.
- An opaque credential reference owned by Authentication.
- An opaque runtime-context ID used to keep native settings, token caches, and session directories isolated.
- Availability state and optional quota-reset information reported by a provider adapter.
- Creation, update, and last-used timestamps.

Credential material never enters the Accounts module. A provider adapter or authentication implementation resolves a credential reference inside its protected boundary.

## Selection and switching behavior

Selection is stored separately for each provider. Selecting an account affects future execution attempts and never mutates the credentials or runtime context of an active attempt.

`chooseEligible(providerId)` uses the selected account when it is reported as available. If the selected account is unavailable, it chooses the most recently used available account, with creation order as a deterministic tie-breaker. Accounts with `unknown`, `unavailable`, or `reauth_required` status are not eligible until an adapter reports them available.

The service records the selected account decision and the execution layer must copy that account ID into its attempt record. Account failover therefore creates a new explicit attempt decision instead of silently changing an existing attempt.

## Provider integration

Codex and Claude adapters will report availability through `updateAvailability`. They remain responsible for provider-specific authentication, quota interpretation, native runtime configuration, and session setup. The account service consumes only normalized observations.

The implementation provides both an in-memory store for headless tests and a versioned JSON-file adapter used by the composition root. JSON stores persist account metadata and opaque references only; credential material is resolved by the host and is never written to those files. A future encrypted credential-vault adapter can replace the in-memory resolver without changing the account service contract.

After an authentication flow succeeds, `AccountsService.reauthenticate` replaces an account's opaque credential reference, optionally rotates its runtime context, clears stale availability and quota observations, and leaves active attempts untouched. It does not perform provider login itself.

## Connection checks (2026-10-16)

Settings > Accounts provides quiet **Connection details** actions for each provider
and saved account. These open a right-side drawer; **Test connection** runs only
when requested inside it. Escape or Close dismisses the drawer and restores focus
to its trigger. Results stay out of the main account list. Provider setup checks resolve the CLI, read its version and,
for Codex, initialize the app-server protocol. They use temporary configuration
and do not inspect the user's default CLI login. Saved-account checks also
ask the provider for local sign-in status in that account's isolated context.
Codex account reads request no token refresh. Claude checks subscription-safe
environment variables just as its sign-in flow does.

The result includes the executable location, version, sign-in observation,
time and an actionable message when a step fails. Each process probe/control
request has a 10-second deadline; a check with multiple steps can take longer
overall. Tests never start model turns or alter selected accounts or their
availability. A saved sign-in does not prove that the network, subscription or
quota permits a model request. Checks are explicit and results are window-local;
reconnecting invalidates the old account result. Credentials and raw CLI output
are not included in the diagnostic result.

## Validation

The account tests cover duplicate identities, provider-scoped selection, availability-gated failover, stale availability clearing, usage tracking, and defensive copies. Connection diagnostics additionally cover ownership validation, request coalescing, bounded process execution, isolated config, normalized account status and exclusion of raw provider output. No provider credentials are used by these tests.

## Provider setup and existing logins (2026-10-22)

Settings > Accounts offers **Use existing Claude login** and **Use existing
Codex login**, plus separate account sign-in. Existing-login connections inspect
the provider's sign-in status and retain the original native configuration
location (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, or the standard home directory).
No credential files are copied. These accounts share CLI settings and history;
changing the CLI login changes the identity used by a linked account, so use
separate sign-in when stable isolation is required. Existing private accounts
are unchanged. Reconnecting uses separate sign-in; choose Use existing login
again to relink a CLI account. Failed link attempts retry the same flow.

Claude requires a native Claude Code installation and `claude auth login` before
linking. Separate Claude sign-in remains available inside Rack. Codex is included
with Rack, so Connect Codex account signs in through the browser without a global
Codex installation. Linking an existing Codex login is optional and reads its
native store using Rack's pinned runtime, without refreshing tokens during the
identity check. Existing API-key-only Codex logins are not subscription accounts.

Build dependencies must include optional packages for the target OS/architecture.
`npm run package:desktop` builds and packages the app with the runtime files
outside asar. Codex updates are delivered by updating Rack's pinned dependency
and release, not by modifying a user's global CLI. Installation-only diagnostics
continue to use temporary configuration and never read a default CLI login.
