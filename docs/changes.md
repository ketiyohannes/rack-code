# Change log

## 2026-10-12 - Local desktop packaging

- Added `npm run package` (`scripts/package-desktop.ts`, @electron/packager). It builds a local app bundle for the current OS and architecture into `release/`, with asar off (the Claude Agent SDK runs a native binary) and ad-hoc signing on macOS. `release/` is ignored by Git.
- The packaged app resolves the login shell's `PATH` at startup (`src/desktop/main/shell-path.ts`) and passes it to the execution host, so provider CLIs installed outside the system `PATH` are found when the app is launched from Finder.
- Moved bundled-only packages (Phosphor icons, fonts) to devDependencies so they do not ship twice.
- Validation performed: `npm run check` passes (37 tests). Packaged on darwin-arm64 (537 MB, mostly Electron and the Claude binary), installed to `/Applications`, and `codesign --verify --deep` succeeded. The app was launched through `open` (Finder-style environment): both connect providers loaded, a Codex sign-in reached a real `auth.openai.com` URL (then cancelled), and the bundled `claude` binary reported 2.1.296.
- Not performed: a run with a connected account in the packaged app; Windows or Linux packaging.

## 2026-10-12 - Simple chat transcript

- Replaced run cards with a Codex/T3-style chat. Prompts are right-aligned bubbles with clipping for long text. Replies are Markdown-rendered page text with a meta row (copy, time, labels, Details, Stop), compact expandable tool rows, inline approval cards, a turn navigator, and a "Scroll to end" pill. Run details moved behind the per-reply Details toggle.
- Added `markdown.ts`, a pure parser with a DOM renderer that uses text nodes only, and tests for blocks, streaming fences, inline markup, and rejection of non-http links.
- Validation performed: `npm run check` passes (37 tests). In the running app, a session with completed turns in the throwaway test data rendered prompt bubbles, the clipped long prompt, inline code, bold, a numbered list, a code block, and meta rows.
- Not performed: streaming, tool rows, and approvals during a live run.

## 2026-10-12 - Verify desktop integration on `feat/minimal-desktop-ui`

- Checked out and validated the desktop branch with the renderer, preload bridge, Electron main process, execution host, and composed application running together.
- Exercised the real bridge to create a project, workspace, and session; confirmed the composer becomes available after selecting a session; opened the Accounts settings; and started and cancelled the Codex sign-in flow.
- Validation performed: `npm run check` passes (typecheck, build, 34 tests, and desktop bundle), the packaged Electron window launches on a clean debugging port, and the live renderer reported no page errors or console errors.
- Not performed: completing a real Codex or Claude sign-in, or running an agent with a connected subscription account.

## 2026-10-12 - Connect Codex and Claude accounts

- Added a Connections core module (`src/core/connections/`) with the `AccountConnector` port and `ConnectionsService`. The service allocates a fresh runtime context, runs the provider sign-in there, and registers the account (or re-authenticates an existing account with the same identity onto the new context) with a `native_login` credential reference. It marks the account available and selects it when the provider has no selection.
- Added `CodexConnector` (app-server `account/login/start` ChatGPT flow) and `ClaudeConnector` (`claude auth login --claudeai` with an isolated `CLAUDE_CONFIG_DIR`), plus `NativeLoginCredentialResolver`, which the composition root now always wraps around the supplied resolver.
- Host contract: `auth.providers`, `auth.connect`, `auth.submitCode`, `auth.cancel`, `auth.active`, the `auth.updated` event, and the `connector_not_found` and `connect_not_found` codes. Host shutdown cancels sign-ins.
- UI: Settings, Accounts now shows "Connect Codex account" and "Connect Claude account" buttons, sign-in progress cards (open sign-in page, device code, code field, cancel, try again), and Reconnect on saved accounts. The manual credential-reference forms were removed from the UI; `accounts.register` remains for headless embedders. The composer shows "Connect an account" when no account exists.
- Validation performed: `npm run check` passes (34 tests, including connect, reconnect, cancel, and error-code tests with a fake connector). A live Codex probe returned a real sign-in URL and cancelled. `claude auth status --json` was checked against an empty isolated directory. The Accounts pane renders both connect buttons.
- Not performed: completing a real Codex or Claude sign-in, or a run with a connected account. Both need the user's interaction.

## 2026-10-12 - Native folder picker for projects and workspaces

- Creating a project now opens the native folder picker, then a small "New project" dialog pre-filled from the chosen folder (name, path with Browse, root-workspace checkbox). The workspace form's path field also has a Browse button. The empty sidebar state is now an "Add a project folder" button.
- Added `selectDirectory` to the preload bridge and a `harness:select-directory` IPC channel handled by Electron main, which validates the sender and options and returns only the chosen path. This is a desktop-shell operation, not a host command.
- Added a reusable modal component (`components/modal.ts`) with Escape, backdrop click, focus trapping, and focus return.
- Validation performed: `npm run check` passes. In the running app, the folder-plus button opened the native macOS picker titled "Choose project folder", attached to the window.
- Not performed: choosing a folder in the native dialog and submitting the dialog end to end (it needs manual interaction); testing on Windows or Linux.

## 2026-10-12 - Retractable sidebars, surface launcher, condensed tree

- Both sidebars are retractable from a new slim toolbar that also shows the session title. A collapsed left sidebar reappears on hover at the window's left edge and floats over the content.
- The right sidebar is now an "Open a surface" launcher with single-key shortcuts. Changes is always listed, and plugin surfaces appear when enabled in the new Settings, Plugins toggles. All plugins are labelled previews with no functionality.
- The sidebar is now a folder tree with nested, condensed single-line session rows showing relative age, and workspace rows are condensed too. The type scale is smaller throughout (wordmark, titles, and body text).
- Validation performed: `npm run check` passes. In the running app, checked that enabling Terminal and Timeline lists them in the launcher, that the T shortcut opens the Terminal surface, that collapsing the left sidebar keeps the grid intact, that hover peek reveals the sidebar, and the tree rendering in light and dark.
- Not performed: a live agent run, so the running spinner was not observed with a real provider; testing on Windows or Linux.

## 2026-10-12 - Restructure the desktop UI layout

- Replaced every native `<select>` with a custom, keyboard-accessible dropdown (`components/dropdown.ts`) rendered in a shared popover (`components/popover.ts`).
- Rebuilt the composer as one card: an auto-growing prompt and a toolbar of pill menus (permission, runtime, account, model) plus a round send button that becomes a stop button while the session has an active run. Capabilities and native permission mappings moved into the menu option descriptions. Enter now sends.
- The sidebar's upper part is now a sessions tree grouped under project folders, with inline new-session forms and running spinners. Workspaces of the current project are below it, and Settings is at the bottom. The project form can optionally add a shared workspace at the root path; this is an explicit checkbox, not an implicit policy.
- The right panel is now reserved for code changes, diffs, and plugins, and shows empty states. Run details expand inline in the transcript instead of in the right panel.
- Added a Settings overlay. General holds the Light/Dark/System appearance choice, Accounts holds account management, and Permissions, Plugins, Shortcuts, Notifications, About, Startup, and Exit behavior are labelled placeholders.
- Contract change: `sessions.list` accepts an omitted `projectId` to list sessions of every project for the tree.
- Validation performed: `npm run check` passes (typecheck, build, 31 tests, desktop bundle). In the running app, checked dark and light themes, the theme choice in Settings and its persistence, menus opening upward with grouped and wrapped options, keyboard selection in a dropdown, creating a session from a folder's inline form, the inline run details, and the Accounts pane in Settings.
- Not performed: a live agent run, so the running spinner and the stop button were not observed with a real provider; testing on Windows or Linux.

## 2026-10-12 - Implement the first desktop UI

- Added the Electron desktop app (see `docs/desktop.md`). Application services run in a separate execution host utility process that owns every in-flight run and pending approval. Electron main validates renderer requests at the privileged boundary and relays them. A two-function preload bridge (`window.harness`) is the renderer's only privileged API.
- Recorded the user's decisions: a framework-free TypeScript renderer with plain CSS, and a utility-process host chosen for maintainability and future background mode. Updated the architecture technology table and source layout.
- Added serializable desktop contracts in `src/contracts/desktop/` (typed command map with runtime validators, host events, views, and stable error codes with structured details).
- Added core read queries for the UI: project, workspace, and session lists, run lists per session, attempt lookup, ordered journal reads, and runtime registry listing. Added typed execution errors (`NoEligibleAccountError`, `WorkspaceProjectMismatchError`, `AttemptNotFoundError`), structured fields on `WorkspaceBusyError` and `DuplicateAccountError`, and `RuntimeAdapter.describePermissionMode` so permission mappings are disclosed by adapters.
- Renderer: sidebar navigator with a spinning indicator on sessions that have an active run, streaming transcript with tool rows and approval cards, run composer with capability-gated permission modes and an unknown-outcome acknowledgement guard, a run inspector (usage, mappings, recovery details, journal), and account management. It offers Light, Dark, and System appearance, Phosphor icons, and bundled Inter and IBM Plex Mono fonts. There are no status indicator dots.
- Stop-on-exit: quitting with active runs asks for confirmation, then cancels them through the host and waits up to 10 seconds before terminating it.
- Validation performed: `npm run check` passes (both TypeScript projects, the headless build, 31 tests including new host-API, contract-validator, and transcript tests, and the desktop bundle). The unpackaged Electron app was launched with an isolated data directory and driven through the real bridge: creating a project, workspace, session, and accounts; duplicate-account and invalid-input errors; starting a run (which failed as expected without credentials); reloading the renderer; switching tabs and appearance; and quitting, after which no Electron or host processes remained.
- Not performed: a successful live agent run (the host has no credential source yet), the approval and cancellation flows against a real provider, visual verification of the session spinner during a live run (covered by code paths and host tests only), packaging, and testing on Windows or Linux.

## 2026-10-12 - Implement headless MVP runtimes and composition

- Added account credential replacement for re-authentication, in-memory credential resolution for tests/embedding, and private per-account runtime-context directories.
- Added durable JSON stores for accounts, projects, sessions, executions, and the append-only journal, with atomic writes and schema-version envelopes.
- Added Codex app-server and Claude Agent SDK adapters behind the provider-neutral runtime contract. They isolate native configuration, translate streaming/tool/approval/usage/availability/completion events, support native resume, and handle cancellation.
- Added the explicit `createApplication` composition root and a public headless API entry point. No UI or Electron renderer was added.
- Added fake-runtime, cancellation, continuation, durable-store, and context-isolation tests, plus `docs/mvp.md` and the post-implementation UI contract in `docs/ui-spec.md`.
- Validation: `npm run check` and `git diff --check` pass. Live provider execution with user credentials was not run; browser/computer-use and background-host features remain deferred.

## 2026-10-12 - Implement accounts domain foundation

- Added the TypeScript/npm project foundation and Node-based build and test scripts.
- Implemented the Accounts capability with provider-scoped identities, opaque credential references, isolated runtime-context IDs, availability observations, account selection, deterministic eligible-account failover, and usage tracking.
- Added an in-memory store for headless composition and tests; provider authentication and durable persistence remain behind separate interfaces.
- Added account capability documentation in `docs/accounts.md`.
- Validation: `npm run check` passes. No provider SDK, credential, or Electron integration was exercised.

## 2026-10-12 - Accept Claude Agent SDK wrapper direction

- Accepted the Claude Agent SDK wrapper model for the product and removed subscription authentication as a technical implementation blocker.
- The Claude adapter will use documented subscription OAuth authentication and per-account configuration contexts, with API-key and other provider modes represented separately where supported.
- Kept credential isolation, native session isolation, and source-term traceability as implementation requirements.
- Validation: reconciled the decision with the current Agent SDK overview, authentication documentation, and Commercial Terms. No runtime authentication or account-isolation experiment was run.

## 2026-10-12 - Clarify SDK product-use and terms conditions

- Confirmed that the Agent SDK is explicitly intended to embed Claude Code's agent loop in a developer application, and that Anthropic's Commercial Terms permit using Services to power products for a customer's own users.
- Recorded the accompanying limits: the Commercial Terms restrict competing products or resale unless expressly approved, and the SDK documentation calls for prior approval for third-party claude.ai login or subscription rate limits.
- Clarified that these are product-use and authentication conditions, not a technical limitation of the SDK. The wrapper architecture and subscription mechanisms remain technically feasible.
- Validation: reread the current SDK overview and the linked Commercial Terms. No legal determination, login, credential access, or runtime experiment was performed.

## 2026-10-12 - Verify Claude SDK subscription mechanisms

- Rechecked the official Agent SDK overview, quickstart, TypeScript reference, authentication guide, and environment-variable reference.
- Documented subscription OAuth token support, account-specific configuration directories and credential storage, per-process SDK environments, account inspection, and rate-limit events.
- Corrected the architecture to distinguish documented technical subscription support from the SDK's separate third-party product approval condition. BYO subscriptions and multiple accounts remain required.
- Validation: fetched and read the current official documentation and checked the documentation diff for whitespace errors. No login, token generation, credential access, SDK execution, or account-isolation experiment was performed.

## 2026-10-12 - Confirm subscription and multi-account scope

- Confirmed that BYO subscription authentication is required for both Codex and Claude, and that multiple saved and selectable accounts are required in the first release.
- Clarified that an API-key-only Claude integration would not satisfy this product scope.
- Kept Claude subscription access as an explicit external feasibility gate because the official Agent SDK documentation requires prior Anthropic approval for third-party claude.ai login or subscription rate limits.
- Validation: reconciled the requirement with the runtime adapter boundary and official integration documentation. No application code or runtime compatibility test was run.

## 2026-10-12 - Make BYO subscriptions and account isolation first-release requirements

- Confirmed that users bring their own Codex and Claude subscriptions and that multiple accounts must work in the first release.
- Defined provider-neutral contracts concretely: core code consumes application-owned run inputs, normalized runtime events, capability flags, and opaque credential references; Codex and Claude protocol types remain inside their adapters.
- Required separate credential, token-cache, native-session, and runtime-configuration contexts for concurrent accounts.
- Recorded Claude subscription authentication as a release feasibility gate because the official Agent SDK documentation requires prior Anthropic approval for third-party claude.ai login or subscription rate limits.
- Validation: reviewed the architecture boundaries and current official Codex and Claude integration documentation. No application code or compatibility experiment was run.

## 2026-10-12 - Select initial runtime integrations

- Confirmed that the first product scope supports both the Codex app server and Claude Agent SDK.
- Defined the product as a provider-neutral wrapper: each runtime is a first-class adapter behind shared application contracts, and future runtimes such as Pi should be addable without changing core sessions, execution, permissions, or persistence.
- Kept authentication scope, account isolation, and automatic account switching open for the next foundational decision.
- Validation: reviewed the decision against the architecture's adapter and dependency boundaries. No application code or runtime compatibility tests were changed.

## 2026-10-12 - Set workspace and recovery direction

- Documented shared workspaces for sequential handoffs and account failover, one app-managed editing run per shared workspace, and isolated workspaces for independent parallel work.
- Made the execution host the logical owner of application state, with current-state records and an append-only execution journal. Documented atomic state updates where possible and explicit handling of external actions with unknown outcomes.
- Kept uncommitted-change transfer, non-Git isolation, storage engine, retention, and backup choices open for their implementation discussions.
- Validation: reviewed the architecture against the user's accepted direction and checked local Markdown links, code fences, and emoji rules. No application tests apply to this documentation change.

## 2026-10-11 - Clarify execution, sessions, and built-in features

- Recorded default stop-on-exit behavior and optional background work, with an independent execution-host boundary proposed for discussion.
- Clarified first-party feature toggles, the intended terminal presentation, four app-owned permission modes, and the shared manual/agent browser requirement.
- Added sourced runtime notes covering native session ownership, Claude's session mirror, approval controls, and documented authentication constraints affecting distribution.
- Kept workspace concurrency, storage details, exact background shutdown semantics, browser implementation, and permission-mode mappings open. No application code was added.
- Validation: read official runtime documentation through the desktop browser and checked local Markdown links, code fences, and emoji rules. No runtime integration tests were performed.

## 2026-10-11 - Set Node.js tooling baseline and record architecture gaps

- Removed Bun from the active architecture and adopted npm with Node.js tooling alongside Electron and Husky, following the user's direction.
- Documented unresolved boundaries around runtime feasibility, process lifetime, sessions, permissions, workspace concurrency, persistence, optional modules, and terminal/distribution behavior.
- Kept those questions open for discussion; no scaffold or application behavior was implemented.
- Validation: reviewed the updated architecture against project rules and prior requirements; checked local links, Markdown fences, and removal of Bun from the active document. No runtime tests apply to this documentation-only change.

## 2026-10-11 - Draft project architecture

- Added `architecture.md` as the architecture entry point, capturing the product direction, core and optional module ownership, adapter boundaries, session continuity, and incremental implementation approach.
- Recorded TypeScript, Electron, and Husky as user-selected directions. Proposed Bun for package management and development scripts while leaving a separate Bun backend and application service placement open for discussion.
- Distinguished proposed structures and unresolved integration behavior from implemented capabilities. No application scaffold, dependency installation, Git initialization, or hooks were created.
- Validation: checked the runtime distinction against Electron and Bun documentation and confirmed Husky documents Bun installation. Reviewed local documentation links and the draft for consistency with the project rules. No runtime compatibility tests have been performed.

## 2026-10-11 - Establish agent rules

- Added root `AGENTS.md` with project-wide rules for branch prefixes, attribution, emoji-free code and documentation, architecture consultation, change documentation, and code comments.
- Recorded the requirement to implement only explicitly approved work, feature by feature.
- Reserved `docs/architecture.md` as the future architecture entry point. No architecture document or application implementation exists yet.
- Validation: reviewed the rules against the user's requirements. No runtime tests apply to this documentation-only change.
