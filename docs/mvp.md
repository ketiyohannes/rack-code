# Headless MVP

Status: implemented, updated 2026-10-14. The headless API remains the core; the Electron desktop UI built on it is described in [desktop application](desktop.md).

The composition entry point is `createApplication` from `@rack/host` (`packages/host/src/index.ts`). It assembles JSON-file stores under one data directory, the Accounts, Projects, Sessions, and Execution services, an isolated runtime-context resolver, and both first-class runtime adapters:

- `codex-app-server` starts `codex app-server --stdio` and translates the app-server JSON-RPC protocol.
- `claude-agent-sdk` uses `@anthropic-ai/claude-agent-sdk` `query()` and translates SDK messages and callbacks.

The composition root accepts a `CredentialResolver`, wrapped in `NativeLoginCredentialResolver`. References created by the Connections sign-in (`native_login`) use the provider's own login in the account's runtime context. Other references go to the supplied resolver; the default `InMemoryCredentialResolver` is suitable for tests and embedding but is not a durable secret store. `ConnectionsService` (with the Codex and Claude connectors) implements "Connect <provider> account". Account JSON contains only an opaque credential reference. Each account's runtime context is hashed below `<dataDirectory>/runtime-contexts`, created with mode `0700`, and passed as `CODEX_HOME` or `CLAUDE_CONFIG_DIR`.

The headless flow is:

1. Register one or more accounts with provider identity, opaque credential reference, and runtime-context ID. Mark an account available after the host or adapter verifies it.
2. Create one project with `projects.createProject({ path })`, then an application session with that `projectId`.
3. Call `execution.start` with the session, project, provider, runtime ID, prompt, model, and one of the four application permission modes.
4. Consume `handle.events`. Events include native session association, message deltas, tool requests/results, approval requests, usage, availability, completion, failure, and interruption.
5. Answer a pending approval with `handle.respondToApproval(id, "allow" | "deny")`, or call `handle.cancel()` to interrupt the attempt. Await `handle.completed` for the durable run outcome.

The application owns run, attempt, session, project-lock, and append-only journal records. Native Codex thread IDs and Claude session IDs are continuations below an application session. A new attempt selects an explicitly requested account or the Accounts service's eligible account; an unavailable selected account falls back to the most recently used available account for that provider. Active attempts keep their original account.

The desktop host exposes `models.list` as the source of truth for model selection. It asks each connected account's runtime adapter for its catalog in the selected project, deduplicates models while retaining the accounts that reported them, and returns partial failures separately. The renderer offers those entries in a grouped list with hidden provider/runtime routing; it never asks users to type a model ID or choose a runtime.

Permission mappings are explicit:

| App mode | Codex | Claude SDK |
| --- | --- | --- |
| `read_only` | `read-only` sandbox, no approval | `plan` |
| `ask` | `workspace-write`, `on-request` approvals | `default` with `canUseTool` |
| `approve_for_me` | `workspace-write`, `on-request`, native `auto_review` reviewer | Native `auto` classifier, no Rack approval callback |
| `full_access` | `danger-full-access`, no approval | `bypassPermissions` with `allowDangerouslySkipPermissions` |

`approve_for_me` delegates approval/denial to each provider’s built-in reviewer. Codex uses `approvalsReviewer: "auto_review"` on thread start/resume and turn start; Claude uses `permissionMode: "auto"` without Rack’s interactive `canUseTool` callback. Native denials remain denials; this mode does not bypass checks. Unsupported settings or an unexpected Codex manual approval request fail visibly rather than silently falling back to Ask me or Full access. The installed Codex 0.162.1 schema and an isolated thread-start smoke check confirmed the reviewer parameter; the installed Claude SDK declares `auto`. Adapters report browser and computer-use capabilities as false. Cross-runtime continuation uses native resume only for the same runtime; application history remains the source of truth for handoff context.

If a provider stream ends without a terminal event, Execution records an `unknown` outcome so the UI can require an explicit recovery decision rather than replaying a possibly completed side effect. Provider exceptions are `failed`, and explicit runtime cancellation is `interrupted`. Durable JSON documents are versioned: accounts remain at schema 1, projects and sessions use schema 4. Execution migrates its schema-4 snapshot to a version-1 append-only log; see [performance improvements](performance-improvements.md) for migration and recovery behavior. General migration tooling, encrypted credential storage, automatic credential refresh, native transcript mirroring, browser integration, and background host lifetime are deferred; Electron IPC and UI presentation are covered in [desktop application](desktop.md). The tests cover account selection and re-authentication, isolated context directories, durable metadata reload, streaming execution, approvals, continuation, journal entries, project release, and cancellation without live provider credentials.

## Project identity and data upgrades

A workspace is the same concept as a project. `Application.projects` owns the selected folder's path and its execution directories; sessions, runs, and model discovery share its `projectId`. Since 2026-10-15, a session's shared or isolated workspace mode selects either the project folder or a session-owned worktree recorded on the project; there is still no second project identity (see [concurrent sessions](concurrent-sessions.md)).

The project store migrates older `projects.json` project/child-workspace data and standalone `workspaces.json` data into `projects.json` schema 4. Distinct folders retain their IDs; duplicate normalized paths use the oldest project ID and retain other IDs as aliases; if both files contain that ID, the newer standalone folder metadata wins. Legacy project roots without a saved folder are retained. All folders are imported before saving a new project, including when the earlier workspace-only migration imported only some records.

Sessions and runs migrate their former `workspaceId` to `projectId`, taking precedence over an obsolete parent project ID, then resolve any duplicate folder alias to its canonical ID. The two session and run histories remain distinct records grouped under the same project. Existing schema 3 projects and schema 2 session/execution documents also upgrade, so duplicates already saved by the earlier rename are repaired. Messages, native continuation IDs, attempts, execution journal, run outcomes, starting revisions, and active writer IDs are preserved. The legacy `workspaces.json` file is left intact; the canonical projects, sessions, and execution documents are upgraded in place. New schema documents are authoritative and do not repeatedly import old folders. Malformed legacy JSON causes a visible storage error rather than an empty import.

The public API and host contracts use the new names only: `projects.list`/`projects.create`, `projectId`, `projectPath`, `projects.changed`, `session_busy` (formerly `project_busy`), and `project_not_found`. The renderer also uses Projects labels and retains the previous sidebar expansion preference. Provider-native permission names such as Codex's `workspace-write` are unchanged.

## Local history import

`Application.sessionImports` discovers local Codex and Claude sessions for a project and imports selected snapshots under the same project identity. Repeat imports return the existing session. Imported history is displayed directly without inventing past Rack runs. First continuation starts a fresh native session with recent visible conversation context, then same-runtime turns use normal resume. See [local session import](session-import.md).

## Read-only project changes

`projects.getChanges(projectId)` resolves the saved folder and reads current Git changes through an injected `ProjectChangesReader` port. `createApplication` supplies the bounded Git reader; the desktop exposes it as `projects.changes` for the right-side Changes surface. Execution does not depend on this preview. It includes pre-existing edits and does not record per-run attribution. See [desktop application](desktop.md) for refresh behavior and preview limits.

## Interrupted-host recovery

Execution startup now reconciles durable queued/running records from a prior host to unknown outcomes, records the recovery in the journal and clears previous-host project writers before accepting new work. Cancellation has bounded native cleanup, including optional force closure of the owned runtime, and ignores late provider output. Explicitly confirmed running-session removal stops and settles the run before deleting the conversation. See [desktop recovery](desktop.md#recovering-after-an-interrupted-app-exit) and [architecture](architecture.md#execution-recovery-and-bounded-shutdown-2026-10-16).
