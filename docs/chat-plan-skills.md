# Chats, Plan mode and installed skills

Current sidebar status (2026-10-19): New chat and the Chats list are hidden
pending a new UI design. The standalone chat services, controller operations,
persistence and existing main conversation experience described below remain
implemented.


New chat starts a conversation without a project. Chats appear above Projects and use the same accounts, models, attachments, streaming, questions, cancellation, deletion confirmation and durable history as project sessions. The first message supplies the default title. Composer text and mode drafts are retained separately while switching conversations within the window.

Each chat has a stable private folder under the application's `chat-files` directory, named with a hash of its saved session ID. This folder is separate from provider credentials and configuration. Native tools can create documents and other files there; Files browses and edits them with the same traversal, symlink and version-conflict protections as project files. Open chat files reveals the folder in the operating system. Terminal and Browser also work without registering a project. Changes and Timeline require an attached project.

Attach project moves the existing conversation under a project in the navigator and preserves its messages and attachments. Attaching waits for the session mutation lane and refuses active execution. It clears native continuation handles so a provider cannot resume a thread in the old working directory; the fresh thread receives recent visible conversation. Existing chat files remain in their original folder rather than being copied into the selected project.

## Planning

Plan is a workflow control alongside permissions in both kinds of session. It preserves the chosen permission setting for later work while execution applies read-only native controls and denies mutating app tools and approval requests. Codex receives native `collaborationMode: plan`; Claude uses SDK `permissionMode: plan`, including a defensive deny for mutations and `ExitPlanMode`. Models can ask clarifying questions through Rack's existing questions UI. A completed plan is ordinary saved assistant content, with Revise plan and Implement actions beside the composer. Failed/interrupted plans cannot be implemented through that action.

Implement submits the ID of the plan the user reviewed. Execution loads the saved result itself, checks that it is the latest completed Plan run in the same session, and includes it in a new normal turn using the selected execution permissions. A plan ID from another conversation or an older/superseded plan is rejected. There is no automatic transition based on model output. Codex's normal collaboration mode is explicitly restored on subsequent turns.

## Skills

Skills opens a searchable picker for the current model and account. Typing `/` in an empty prompt opens the same picker. Selected skills appear as removable chips and are retained independently per session/runtime/account. Opening or refreshing re-reads the catalog, removes unavailable selections and shows discovery failures and disabled entries. No skill is installed, edited or globally enabled by using the picker.

The host accepts skill IDs only. Immediately before starting a run, Execution re-discovers skills using the account actually selected for that run, validates every ID and passes the resulting adapter-owned references to the runtime. Account fallback cannot inject paths from another account. Missing, disabled or stale selections fail before a run is created.

Codex uses native `skills/list`, including its account/project/system discovery, plus process-local extra roots for the user's `.agents/skills`, `.codex/skills`, and an explicitly configured parent `CODEX_HOME/skills`. Turns include both the textual invocation and native `{type: "skill", name, path}` input.

Claude discovers personal `~/.claude/skills`, isolated account skills, skill folders from installed Claude plugin registries (respecting project installation scope), and `.claude/skills` in the working folder's ancestors. Each explicit selection is loaded as a temporary local skill-only plugin with its own stable namespace; symlinks preserve scripts and relative resources. A single selection dispatches its native slash command, including manually invoked skills; multiple selections request the SDK's native Skill tool. Temporary wrappers are removed when the query ends. Global authentication/settings/hooks are not copied into an account to expose installed skills. Provider-specific tool or MCP dependencies must still be available to that provider; Rack does not convert skills between runtimes.

## Contracts and storage

`SessionRecord.projectId` and `RunRecord.projectId` are optional for a standalone chat. Session and execution JSON documents use schema 4. Schema 3 upgrades preserve records exactly; schemas 1–2 retain the existing workspace/canonical-project migration before upgrading. Projects keep their existing schema and locking rules. Execution additionally reserves a session before asynchronous validation so concurrent headless callers cannot run two turns in one conversation.

New host commands expose skill discovery, project attachment, trusted session directory resolution and session-scoped file access. `runs.start` adds `interactionMode`, `skillIds` and `approvedPlanRunId`; old clients default to normal workflow. Optional capabilities remain composed outside core. Chat usage is included in aggregate analytics and excluded from a project-only filter.
