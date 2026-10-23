# Import local sessions

Status: implemented 2026-10-14. Imports local Codex and Claude conversations into a selected Rack project. This is a conversation snapshot, not live synchronization or filesystem recovery.

## Use

1. Add the project folder in the sidebar if it is not already present.
2. Click its database icon, labelled **Import local sessions into <folder>**.
3. Check individual sessions or **Select all**. Select all excludes conversations already imported. Click a session title to preview it independently of its checkbox.
4. Click **Import N sessions**. Successful imports are saved even if another selection fails; failed selections remain checked for retry. Previously imported entries are labelled **Imported** and can open their existing Rack session.

The import retains supported visible conversation and tool activity, including content omitted from the preview. Original transcripts and login credentials are not copied or altered. Images/documents are labelled as attachments that were not imported. Readable thinking exposed by the provider history API is retained and labelled as trace text or a summary. Opaque/encrypted reasoning state and unsupported native items are not reconstructed. No past Rack runs, permission approvals, or tool outcomes are invented.

If one provider cannot be read, the dialog reports its failure while keeping the other provider's sessions available. Empty results mean no readable sessions matched that exact folder. Refresh retries discovery. A missing or unreadable session produces an error rather than a partial Rack session.

## Discovery boundaries

- Codex starts the installed `codex app-server --stdio` against the user's normal local Codex store. Only initialization and `thread/list`, `thread/read`, and, when needed, `thread/turns/list` are used. Discovery filters to the selected folder and interactive/unknown sources, omitting active threads reported by the source. Reads have a 30-second deadline, and source processes are closed after every operation. No model turn, resume, fork, sign-in, or transcript mutation command is sent.
- Claude uses the installed Agent SDK's `listSessions`, `getSessionInfo`, and `getSessionMessages` history helpers. Worktree inclusion is disabled and the returned working directory is verified. No query/model request is started.
- Both readers use normal local provider stores selected by their inherited environment, rather than Rack's isolated account contexts. The host revalidates source identity and folder before saving. Renderer commands cannot supply native transcript paths or credential directories.

Codex's [app-server reference](https://learn.chatgpt.com/docs/app-server) documents history APIs. Claude's [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) and [session guide](https://code.claude.com/docs/en/agent-sdk/sessions) cover history helpers and continuation. Installed SDK types and Codex-generated protocol schemas were inspected during implementation.

## Continuation

Imported native IDs are provenance, separate from Rack's native continuation associations. Account directories are isolated, so an external native ID must not be passed blindly to a runtime using another store.

The first Rack run starts a fresh native session with recent visible user/assistant conversation quoted as historical context. Visible text has a 60,000-character budget; the full imported history stays in Rack for viewing. Historical tools are displayed but not replayed. The user's prompt remains unchanged in Rack's records, and the selected account, model, project, and permission mode remain authoritative. After the new runtime returns a native session ID, later same-runtime turns use normal resume.

Import does not restore project files. Native resume across external account stores, exact restoration of provider context/compaction state, live synchronization, export files, additional providers, archived Codex threads, and subagent histories are outside this first implementation.

## Ownership and persistence

`SessionImportsService` coordinates Projects and Sessions through public interfaces. Native parsing lives in `packages/runtimes/src/session-imports/`; startup composition supplies the sources. `CreateApplicationOptions.sessionSources` allows tests and alternate hosts to replace them explicitly.

The host exposes `sessions.discover`, `sessions.previewImport`, and `sessions.import`, scoped by `projectId`. Import saves a complete snapshot in one store mutation and serializes concurrent requests so `(projectId, sourceId, nativeSessionId)` identifies one imported session. `SessionRecord.importSource` and message provenance are additive fields in the existing schema.

Historical messages appear before subsequent Rack runs. Exposed thinking is displayed as open prose; tool activity uses the same formatted cards as new runs. There are no controls that execute past tool requests. The dialog reuses the app's modal, colors, typography, and typed host bridge.
