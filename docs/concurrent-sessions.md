# Concurrent sessions: shared and isolated workspaces

Status: ported from `rack-code-concurrent` to `feat/concurrent-workflows` on 2026-10-19, preserving the desktop UI and append-only execution store. Sessions can share the project folder or use separate Git worktrees.

## What it does

Several sessions of one project can run at the same time. Each session chooses where it runs:

| Mode | Where runs execute | Concurrency |
| --- | --- | --- |
| **Shared folder** (default) | The project folder | Runs concurrently with other shared sessions. Edits are **not** isolated: two agents can change the same file, last write wins. This matches T3 Code's "Current checkout" and Codex's Local mode. |
| **Isolated worktree** | A Git worktree and branch owned by the session | Never shares files with other sessions. Matches T3 Code's "New worktree" and Codex's Worktree mode. |

Each session still runs one turn at a time (`session_busy`).

## Using it

- **Choosing a mode.** The composer's workspace icon offers Shared folder or Isolated worktree while the session has no messages. After the first message it is disabled, because Claude and Codex tie a conversation to the working directory it started in. T3 Code locks the choice the same way. New sessions default to Shared.
- **First message of an isolated session.** Rack creates the worktree, then starts the run. The host returns a queued run handle while preparation continues; the turn shows "Preparing worktree" meanwhile. Stop prevents provider startup, but an in-progress Git setup finishes before the run settles. A creation failure fails that run with the Git error, and the next message tries again.
- **Session header.** An isolated session shows a branch chip like `rack/1a2b3c4d`, with the isolated mode in its accessible label and tooltip. Its menu shows uncommitted changes and commits on the branch, and offers **Reveal worktree folder**, **Copy branch name**, and **Remove worktree**. A shared session shows a warning icon and count while other shared sessions of the project are running; its tooltip explains that they share files.
- **Tools and opened paths.** Files, Terminal, Changes, repository discovery, editor targets and relative transcript links use the isolated session's worktree. Before creation or after removal, tools explain that a message must create or restore it; they never silently open the shared checkout. Side-chat context also points to the worktree when available.
- **Timeline.** Per-session recording captures that session's worktree. Worktree preparation finishes before the baseline capture and provider startup. Saved snapshots remain readable after removal because linked worktrees share Git objects. Project-wide history and its background watcher continue to observe the main checkout. Concurrent shared sessions can observe each other's edits; their snapshots cannot establish exclusive attribution.
- **Getting work back.** The session's work lives on its branch. Commit in the worktree (or ask the agent to), then merge the branch or open a pull request with your usual Git tools. Rack has no merge or "apply" step yet. T3 Code also integrates through branches and pull requests only.
- **Remove worktree.** Deletes the worktree directory and keeps the branch, as T3 Code does. With uncommitted changes, Rack asks before discarding them. The next message in that session recreates the worktree from its branch.

## How isolated worktrees are created

| Aspect | Behavior | Source of the convention |
| --- | --- | --- |
| Location | `<data directory>/worktrees/<repo name>-<hash>/<branch slug>`, outside every repository | Both use an app-managed folder; Codex adds a hash bucket |
| Branch | `rack/<8 hex>`, created from the main checkout's current HEAD commit | T3 Code (`t3/<8 hex>`) |
| Base and uncommitted changes | The commit at HEAD; uncommitted changes are **not** carried over | T3 Code and the Codex CLI |
| Hooks | Repository hooks and fsmonitor are disabled while creating and restoring | Codex |
| Subfolder projects | A project that is a repository subfolder runs in the same subfolder of the worktree | Codex |
| Submodules | `git submodule update --init --recursive`, best effort | T3 Code |
| Ignored files | `.worktreeinclude` at the repository root (gitignore syntax). Files that are ignored **and** match are copied. No overwrite; symlinks skipped; copy-on-write clones on APFS, so `node_modules` is cheap. | Codex app |
| Parallel creation | Serialized per repository | Avoids the Git lock contention reported by T3 Code users |
| Failure | Removes the half-created worktree and its new branch | T3 Code |
| Missing directory | Recreated from the branch, or from the base commit if the branch was deleted | T3 Code |

Example `.worktreeinclude`:

```gitignore
.env
.env.local
node_modules/
```

## What providers handle, and what Rack handles

The rule is to use provider behavior where it exists. Verified 2026-10-15 against the installed versions:

- **Codex app server (CLI 0.162.1).** `thread/start` and `turn/start` accept `cwd`; there is no worktree method. Codex's managed worktrees are a CLI/TUI and desktop-app feature, not part of the protocol an embedding app uses. Rack passes the session directory as `cwd`.
- **Claude Agent SDK (0.3.296).** No option starts a session in a new worktree; `EnterWorktree` is an agent-invoked tool and `--worktree` is a CLI flag. The SDK does offer `projectConfigRoot` for sessions whose `cwd` is a worktree. Project settings (hooks, permissions, `.mcp.json`, `.claude` trees) then come from the trusted main checkout instead of the session branch. Rack sets it to the main checkout for isolated sessions.
- **Rack.** Creates, restores, and removes worktrees; records them on the project; and decides which directory each run uses. Rack must own this because one Rack session can continue across Codex and Claude, and across accounts with separate provider stores. A provider-owned worktree would not follow the session.

## Architecture

- **Projects** (`src/core/projects/`) owns execution directories:
  - `IsolatedWorkspace` records persist on `ProjectRecord.isolatedWorkspaces` (an additive field in schema 4).
  - `prepareExecutionDirectory(projectId, sessionId, mode)` returns the folder or worktree, creating or restoring the worktree on demand and serializing per session.
  - `workspaceState` and `removeIsolatedWorkspace` serve presentation and cleanup.
  - The `IsolatedWorkspaceProvider` port is implemented by `GitWorktreeProvider` (`src/adapters/projects/git-worktrees.ts`).
- **Writer ownership is in memory.** `acquireWriter(projectId, attemptId, { sessionId, mode })` rejects only a second run of the same session (`SessionBusyError`). The execution host owns every run and no run survives it, so the old persisted `activeWriterAttemptId` lock could only survive a crash as a stale lock. It is now ignored.
- **Sessions** own `workspaceMode` (absent means shared). `setWorkspaceMode` is refused once the session has messages.
- **Execution** acquires the writer, prepares the directory (the run stays `queued`), and passes it to the runtime as `projectPath`, plus `checkoutRoot` for isolated sessions.
- **Composition** assembles the provider with `<data directory>/worktrees`.
- **Desktop contract:**
  - `sessions.create` accepts `workspaceMode`.
  - New commands: `sessions.setWorkspaceMode`, `sessions.workspace`, and `sessions.removeWorkspace`.
  - `projects.changes` and `projects.repositories` accept `sessionId` (same project only).
  - `ProjectView.activeWriters` replaces the writer field.
  - Error codes: `session_busy` replaces `project_busy`; new `isolation_unavailable` and `workspace_dirty`.

## Not implemented yet

- Worktree-specific merge, "apply to project", PR creation, and conflict handling. The existing PR feature remains repository based.
- Moving an existing conversation between modes (Codex's Hand off).
- Per-project setup commands for new worktrees (T3's `t3.json` scripts, Codex local environments). `.worktreeinclude` covers copying ignored files; installs are left to you or the agent.
- Choosing a base branch other than the current HEAD, or carrying uncommitted changes into a new worktree (the Codex app does this; T3 does not).
- Automatic cleanup or retention limits (Codex keeps 15). Worktrees stay until removed.
- Codex `workspace-write` runs cannot write the worktree's Git metadata, which lives in the main repository's `.git`. Agents may therefore be unable to commit in isolated sessions without full access. Codex has the same limitation in its own worktrees (openai/codex#48717). Rack passes only the provider's documented controls and does not widen sandbox roots.
- Session deletion retains its worktree and branch to avoid discarding work. Remove the worktree from its header menu before deleting the session if you want cleanup; automatic deletion-time cleanup is not implemented.

## Validation

See `docs/changes.md` (2026-10-19). Real temporary Git repositories and deterministic runtimes exercise concurrent execution and worktree/tool/Timeline integration. Live provider concurrency and packaged applications have not been tested.
