# Terminal, Browser and Files

Enable these implemented surfaces in **Settings > Plugins**, then open them
from **All surfaces** in the right sidebar. Launcher shortcuts are **T**,
**B** and **F** when focus is outside a text field. Hiding/disabling a surface
changes its presentation; it does not close its shell or page.

## Terminal

- A real PTY opens in the project directory. A selected conversation owns
  its shell; otherwise the project owns it. Switching surfaces/conversations
  and reloading the renderer reconnect to the same host-owned process.
- Conversations whose latest run used Codex try its standalone `command/exec`
  PTY, with the run's isolated account context. This creates no thread/model
  turn. Claude's installed SDK has no equivalent standalone terminal API;
  other contexts use a local `node-pty` shell. Unsupported native startup can
  fall back before a process is established. Started commands are never retried.
- xterm supplies ANSI rendering, scrollback and interactive input; terminal
  keystrokes stay out of chat shortcuts. Input is ordered across clients and
  paste chunks, resize follows the panel, and exit codes remain visible.
  **Close** terminates a shell; **New shell** replaces it. Session removal and
  application shutdown release its processes. xterm initializes only after
  DOM attachment so the renderer can measure its font and dimensions.
- Manual terminal input is user-owned, independent of model permission
  settings. Native agent shell tools retain their provider permissions and
  execution journal. This panel does not mirror every model command.
- Limits: 12 retained contexts including exited shells, 262,144 UTF-16 code
  units of host output per context, 5,000 xterm scrollback lines. Absolute
  output offsets detect truncation. Shells/output do not survive app exit.

After upgrading Electron, run `npm run rebuild:native` for `node-pty`.

## Browser

- Each conversation owns one live Chromium page, shared between user and
  agent. The toolbar offers an HTTP/HTTPS address, Back, Forward, Reload,
  **Pause agent / Resume agent**, and **Close page**. Popups open in that same
  page. Hiding the panel, switching sessions or reloading the renderer retains
  it; session removal, closing the page and app exit release it.
- Up to 12 pages may be open. State polling does not allocate pages. Each
  conversation has its own in-memory profile, including cookies and site
  storage, isolated from the others and discarded on app exit. Downloads,
  privileged navigation and unsolicited browser permissions are blocked.
- Websites run in sandboxed native views without Node, preload or the Rack
  bridge. Main owns page lifetime and bounds; the trusted renderer owns the
  toolbar. Views detach for Settings, menus, modals and hidden surfaces.
- The agent's `rack_browser` tool supports snapshot, navigate, click, type,
  select, press, scroll, back, forward and reload. `text` supplies field text,
  an option value or a key name. Keys: Enter, Tab, Escape, Space, arrows,
  Backspace, Delete, Home, End, PageUp and PageDown. Keyboard control works
  in detached pages through Chromium's page channel and focus emulation,
  without activating the user window.
- Snapshots return bounded page text, up to 200 visible controls, and fresh
  opaque references after every snapshot/action. Field values are omitted;
  select options expose their values. Stale references fail with actionable
  errors, including after navigation. Maps live in an isolated world.
  Website text is untrusted data, not instructions for the app.
- Pausing blocks all agent reads/actions without preventing user browsing.
  Only the user can resume control or use lifecycle controls. Read only mode
  allows snapshots/scrolling and denies mutations. Ask uses Rack's approval
  broker. Approve for me preserves native provider review, with no additional
  Rack prompt and no Claude allow-list bypass. Full access executes without
  approval prompts. Cancellation releases pending approvals before awaiting
  native shutdown so an unanswered tool cannot deadlock a run.
- Composition exposes the optional tool through Execution's app-owned port.
  Runtime adapters configure an authenticated loopback MCP endpoint for fresh
  and resumed Claude/Codex sessions. A run-specific token is required and
  website Origin headers are rejected. Cancellation/run settlement closes the
  listener. Headless composition without a driver exposes no browser tool
  and browser commands report `feature_unavailable`.

## Files

- Browse the selected project's working files, enter folders, go up, filter
  a folder and Refresh. Folders sort first. Listings are bounded at 1,000
  entries with an explicit truncation notice. Files remain ordinary buttons
  inside accessible list items.
- Existing regular UTF-8 files up to 1 MiB open in the text editor, including
  empty files. Binary, non-UTF-8 and larger files offer an explanation and
  external opening. Symlinks stay visible but cannot be followed. Absolute
  paths, traversal and special files are rejected; FIFOs cannot block reads.
- **Save** or **Cmd/Ctrl+S** writes explicitly. Tab inserts two spaces. Saves
  preserve UTF-8 BOM, existing CRLF endings and ordinary permission bits,
  including executable bits. Agent file tools access the same working files.
- Saves compare content hashes before replacement and again before an atomic
  rename. `file_conflict` retains the user's draft and the external edit.
  Equivalent paths share a host save lane. External editors/providers do not
  participate in that lane, so the final check narrows the cross-process race
  rather than claiming an OS-level compare-and-swap operation.
- Drafts belong to project/path and survive panel/project switches in the
  current renderer. Up to 24 documents are retained; clean entries may be
  evicted, dirty drafts are not. **Discard & reload** asks for confirmation
  with Cancel focused. Failed reads keep the draft; pending reloads cannot
  overwrite text entered after confirmation. Save before renderer reload or
  app exit: unsaved drafts are in memory. File creation/deletion/renaming and
  rich/binary editing remain operations for native tools or external editors.

## Ownership and verification

`src/features/{terminal,browser,files}/` own services and contracts. Explicit
composition supplies project/session lookups and adapters. Filesystem and
PTY work run in the host, Chromium views in Electron main, and presentation
in the sandboxed renderer. Core execution imports only its own optional tool
and terminal ports, never optional features or provider-specific types.

`npm run check` runs types, compilation, automated regressions and desktop
bundling. `npm run test:desktop-features` also checks real Chromium pages,
local PTYs and Codex standalone PTYs against disposable files, profiles and
a loopback website. It requires a desktop environment and Codex CLI, and
starts no provider login or model turn. Adapter MCP tests use controlled
runtimes; authenticated model-driven browsing remains a live integration check.

## Standalone chat workspaces

Files and Terminal also accept session context without a project. Composition resolves the saved chat ID to its private workspace, separate from authentication directories; the existing file and PTY adapters retain their protections and lifecycle. Browser already uses session identity. Changes and Timeline require a project. See [Chats, Plan mode and installed skills](chat-plan-skills.md).
