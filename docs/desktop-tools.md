# Terminal, Browser and Files

The right sidebar starts with one empty **New tab** showing an icon grid for
Changes, Run details, Terminal, Browser, Files and Timeline. Tooltips identify
each tool and its purpose. Planned tools are omitted until implemented.
Choose an item to fill that tab. **+** keeps its dropdown: choose **New tab**
for another blank tab, or a tool for another tool tab. Choosing an optional tool
enables its Settings plugin. Existing tools are focused rather than duplicated,
since each tool has one session-owned panel. Enabled plugins do not open tabs
automatically. New windows always start blank, regardless of older tab settings.

Close a tab with its **x** (or Delete while focused); the last close leaves a
blank tab with the surface list. Closing a tab retains its shell, page or file
draft for the window's lifetime; it does not terminate the tool. Arrow keys and
Home/End switch tabs. The strip scrolls when the sidebar is narrow. Settings >
Plugins still controls optional tool visibility.

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
  **Close shell** terminates a shell; **Restart shell** replaces it. These are
  compact icon actions above the flush terminal viewport. Session removal and
  application shutdown release its processes. The terminal initializes only after
  DOM attachment so the renderer can measure its font and dimensions.
- Manual terminal input is user-owned, independent of model permission
  settings. Native agent shell tools retain their provider permissions and
  execution journal. This panel does not mirror every model command.
- Limits: 12 retained contexts including exited shells, 262,144 UTF-16 code
  units of host output per context, 5,000 terminal scrollback lines. Absolute
  output offsets detect truncation. Shells/output do not survive app exit.

After upgrading Electron, run `npm run rebuild:native` for `node-pty`.

## Browser

- Each conversation owns one live Chromium page, shared between user and
  agent. One integrated toolbar offers Back, Forward, Reload, a search/address omnibox,
  agent pause/resume and Close controls. Cmd/Ctrl+L focuses the omnibox from
  the website as well as app chrome. Enter navigates; there is no second URL form
  or separate actions row. Bare searches use Google; explicit addresses use HTTP/HTTPS. Popups open in that same
  page. Hiding the panel, switching sessions or reloading the renderer retains
  it; session removal, closing the page and app exit release it.
- Native page bounds account for Rack page zoom so websites stay aligned with
  their viewport at different zoom levels. Up to 12 pages may be open. State polling does not allocate pages. Each
  conversation has its own in-memory profile, including cookies and site
  storage, isolated from the others and discarded on app exit. Downloads,
  privileged navigation and unsolicited browser permissions are blocked.
- Websites run in sandboxed native views without Node, preload or the Rack
  bridge. Main owns page lifetime and bounds; the trusted renderer owns the
  toolbar. Views detach for Settings, menus, modals, splitter drags and hidden tabs.
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

## Opening in an editor

The **Open in editor** code icon in the conversation/project header opens the working folder. The
Files panel's editor button opens the selected file. The menu detects installed
VS Code/Insiders, Cursor, Windsurf, Zed, Sublime Text, JetBrains editors, and
other common editors. **Choose application…** invokes the OS picker for other
installations; **Default application** keeps the existing safe-open behavior.
Discovery covers standard system/user application folders on macOS, common
installation folders on Windows, and editor executables on PATH on Linux.
Nonstandard installations can use the chooser. Unsaved in-app file drafts are
not implicitly saved; external editors read the file on disk.

Desktop main validates editor IDs, re-discovers their application paths and
passes literal file/folder arguments without a shell. Provider text cannot name
an arbitrary executable. Relative files resolve against their original saved
project/chat workspace even if navigation changes while the menu is loading.

## Typography and bundled assets

Every font size comes from one type scale defined at the top of `styles.css`:
10, 11, 12, 13 (interface base), 14, 16, 18 and 22 px steps. Prompts, user
bubbles, assistant prose and tables use the 14px content size. Inline/fenced
code, tool output, diffs, Files and terminal text use the 13px code size.
Navigation and metadata retain the compact steps. Normal app zoom scales
everything together.
The original xterm renderer is bundled locally with its CSS, with no external
terminal application or WASM asset. Its generated style elements supply cell
geometry and ANSI colors; the trusted renderer still blocks inline scripts,
eval and remote resources. Terminal colors follow the app palette.

The chat transcript occupies a bounded viewport and scrolls independently of
the prompt. Drag the horizontal divider above the prompt to change its height,
or use Up/Down when the divider is focused. Double-click restores 200px; the
minimum is 148px and the maximum keeps conversation history visible. The height
persists per device. Long drafts, attachments and question cards scroll within
the prompt area. Sidebars retain their draggable inner-edge width splitters;
the native browser detaches during a drag and returns at the final bounds.


## Compact controls (2026-10-19)

Files uses named icon buttons for save, reload and external editor selection.
The reload tooltip changes to “Discard changes and reload file” for a dirty
draft; the existing discard confirmation still protects that draft. Save keeps
the existing keyboard shortcut, version checks and disabled/pending behavior.
The + tool menu starts keyboard focus on its first item and supports arrows,
Home/End, Escape and Tab. Tool enablement and resource lifetimes are unchanged.

## Concurrent session directories

Files and Terminal follow the selected session's execution directory. An isolated session uses its worktree, including for external editor actions; shared sessions use the project folder. Changing the workspace mode or removing a worktree closes the old shell context. A missing isolated worktree produces a create/restore message instead of falling back to project files. Changes and repository discovery also follow the isolated session. See [concurrent sessions](concurrent-sessions.md).
