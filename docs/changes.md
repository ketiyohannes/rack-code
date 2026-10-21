# Git source control in Changes; single Timeline view (2026-10-21)

- **Timeline:** removed the **This session** tab. The panel now has **Current branch** (renamed from Project history) and **All branches**. Previously recorded session checkpoints still appear in project history. The host's session-recording commands are unchanged, but the panel no longer offers a way to enable or disable session recording.
- **Changes is now a VS Code-style Git source-control view:**
  - A commit box with Commit, Commit all, Commit merge, Commit & Push/Publish, Commit & Sync, and Amend.
  - An ahead/behind sync button, or Publish for unpublished branches.
  - A branch menu with switch, create, merge and abort merge.
  - Pull, Push, Fetch, Sync, Stage all, Unstage all and Discard all in a repository menu.
  - Per-file and per-group stage, unstage and discard actions, also in a row context menu.
  - A merge-in-progress banner.
  - Discard and amending a pushed commit confirm first.
- **New contract:** `projects.sourceControl` (Projects `ProjectSourceControl` port, `GitSourceControl` adapter) and the `git_operation_failed` error code. `projects.branches` and `projects.checkoutBranch` accept an optional `repositoryPath` (and `sessionId` for listing). `ProjectChanges` gains `upstream`, `ahead`, `behind`, `merging` and `hasCommits`, read from the existing status and rev-parse processes with no extra Git processes per poll.
- **Safety:**
  - Literal pathspecs and path validation.
  - No shell, prompts or controlling terminal for Git.
  - Inherited `GIT_DIR`-style variables are removed.
  - Timeouts kill the process group.
  - Remote URL credentials are redacted in errors.
  - Pull, sync, merge and abort merge are refused while a run writes in the same canonical working tree.
  - Isolated session worktrees cannot create or switch branches.
  - User hooks run, as in the Git CLI.
- **Validation:**
  - Six new adapter and service tests against real temporary repositories and a local bare remote: literal and option-like file names, path traversal, ignored files surviving discard, commit rules including the hidden-staged-file refusal, publish/push/fetch/pull/sync with divergent histories, merge conflicts with abort and conclude, branch name validation, the active-run guard and credential redaction.
  - Full `npm run check` passed: both type checks, the build, 316 unit tests and the desktop build. A later renderer-only fix (capturing the project identity for row actions) was re-checked with the renderer type check, the desktop build and the fixture commit flow.
  - A Chromium renderer fixture with a stateful mocked host checked the commit draft surviving polling, ⌘Enter commit, row stage, context menu and delete confirmation (Cancel focused), a rejected push error with redaction, merge with conflicts, then resolve and commit merge, create branch then publish then sync, isolated-session branch restrictions, Timeline's two tabs, and layout at 980 × 600. No browser errors.
  - Not performed: live push/pull against GitHub or other hosted remotes, SSH remotes, signed commits, hooks that prompt, and the packaged Electron app.

# Remove gaps between sidebar project folders (2026-10-21)

- Remove vertical margins between project groups and around their expanded session lists. Keep folder row sizes, controls and indentation unchanged.
- Validation: desktop build passed. Chromium measured 0 px between all four fixture project groups and 0 px top/bottom margins on expanded session lists; folder rows remain 36 px tall. No browser errors were reported. The unit suite was not rerun for this CSS-only change.

# Collapse the right sidebar after closing its final tab (2026-10-20)

- Closing the last workbench tab (including a blank tab, via its close button, Delete or Backspace) now collapses the right sidebar. The shell owns the saved collapse preference and returns keyboard focus to its toolbar toggle. Closing one of several tabs keeps the panel open. Reopening shows the blank launcher; direct tool requests reveal their tool normally.
- Validation: type checks and desktop build passed. Chromium checks passed for closing the final blank/tool tab by mouse, Delete and Backspace, retaining the panel while another tab remains, saved collapse state, focus returning to the visible toggle, reopening the launcher and direct side-chat requests revealing the panel. The initial fixture omitted the Changes diff field; after correcting that mock, repeated tab-close interactions produced no browser errors. The full unit suite was not rerun for this UI-only behavior change.

# Compact sidebar Timeline rows (2026-10-20)

- Put each entry title, file count and relative time on one line. Remove decorative kind icons, visible source labels (including Observed edit), and the separate branch-label line. Keep full title/provenance/branch/merge metadata in tooltips and preserve disclosure/snapshot actions.
- Validation: type checks and desktop build passed. Chromium checks confirmed inline title/count/time, no decorative source icon or Observed edit label, working expand/collapse, and no overlap or document overflow at 980 × 600. No browser errors were reported. The full unit suite was not rerun for this presentation-only change.

# Restore Timeline scrolling (2026-10-20)

- Give Timeline its own bounded vertical scroll container inside the clipped workbench surface. Keep controls, notices and long checkpoint lists reachable at small window heights. Preserve the panel scroll offset when refresh replaces its history; switching scopes starts at the top.
- Cause: the outer Timeline surface hid overflow, while the content/list had no scroll owner. Earlier layout checks did not exercise wheel scrolling.
- Validation: type checks and desktop build passed; Chromium wheel checks with a 60-entry fixture reached the final entry, retained the 600 px scroll offset across refresh, and worked in Project history, All branches and This session at normal and 980 × 600 windows without document overflow. No browser errors were reported. The full unit suite was not rerun for this CSS/scroll-offset fix.

# Timeline branch checkout and global history (2026-10-20)

- Add **All branches**, a repository-wide topological history over local/remote-tracking branches, every merge parent and supported saved snapshots. Show branch-tip labels, merge icons/parents and first-parent comparisons; retain empty commits and merges. Global entries open through existing previews and the expanded snapshot viewer. Keep the bounded 200-entry notice and current visibility rules.
- Add a project-checkout branch picker with confirmation, path display, remote tracking and worktree occupancy. Projects owns explicit Git mutations through a new adapter/port. Refuse dirty/stale/invalid requests, occupied branches and repository writers (including alias projects); close run-start races with a checkout barrier. No forced checkout, automatic stash, fetch, hook execution or isolated-worktree reassignment.
- Validation: focused real-Git checkout/global-history tests passed (36). Type checks and desktop build passed. Chromium fixtures verified all-branch rows/labels, merge presentation, checkout confirmation/routing, dirty-state blocking, worktree occupancy, snapshot scope, tab keyboard navigation and no document overflow at 980 × 600. `npm run check` passed (310 tests, both type checks and both builds); final type checks/build and checkout-focused tests passed after review adjustments. No browser errors were reported. Live providers, real user repository checkout and packaged application checks were not performed.

# Reading-region context menus (2026-10-19)

- Add right-click and keyboard context menus to the main transcript and both PR review views. Open side chat, ask about selected text, copy text/links, and access PR explanation, Timeline and code-host actions. Preserve normal form controls.
- Selected excerpts become bounded editable side-chat drafts; append to existing drafts and send only when requested. Reuse existing side-chat contexts, permission modes and provider controls. Menus use current theme tokens, icons, cursor clamping, arrow/Home/End navigation, Escape and outside-click dismissal.
- Validation: `npm run check` passed (305 tests, both type checks and both builds). Chromium fixture checks cover main/PR selection drafts, draft preservation, no automatic provider run from drafting, keyboard opening/navigation, focus restoration, input behavior and window-edge clamping. Final focused tests (27), type checks and renderer build passed after the streaming guard adjustment. Browser checks also cover both PR views, selected diff copying and PR URL copying through a mocked clipboard, outside-click dismissal, captured excerpts surviving node replacement, and Escape dismissing the menu without cancelling a live main run. No browser errors were reported. Live providers and packaged builds were not exercised.

# Reopen saved PR side chats (2026-10-19)

- Automatically display a PR's existing side chat in both the inbox and repository view when its saved session has messages. Keep empty/deleted chats closed, ignore stale history replies after navigation and respect manual closing during refreshes. Reopening reads saved history without sending an AI request or moving keyboard focus.
- Share the existing per-device mapping through `side-chat-state.ts`; no host or persistence schema changes.
- Validation: `npm run check` passed (303 tests, both type checks and both builds); `git diff --check` passed. Chromium fixture checks confirmed saved explanations reopen in the inbox and repository view, PRs without history stay closed, and refresh respects manual closing. No provider run was started and no browser errors were reported. Unit coverage includes empty/deleted history, stale replies and revisit behavior. Live provider turns were not exercised.

# Concurrent workflows port (2026-10-19)

- Port shared-folder and isolated-worktree sessions from `rack-code-concurrent` onto `feat/concurrent-workflows`, created from `dev` after the performance release was pushed and merged into `dev` and `main`. Preserve append-only execution storage, paged history and scoped rendering.
- Replace the project-wide writer lock with live session ownership: different sessions can run together, while a second turn in the same session is refused. Expose queued handles during worktree preparation; cancellation prevents provider startup. Claude receives the main checkout as its project configuration root.
- Route Files, Terminal, Changes, repository discovery, editor targets and side-chat context to the selected session's worktree. Missing worktrees report a create/restore message. Capture Timeline baselines after worktree setup and retain readable saved snapshots after removal. Project background history remains tied to the main checkout. PR publishing consults live writers rather than the retired lock field.
- Add a compact workspace icon before the first message, an isolated branch menu, a shared-writer warning count, and dirty-worktree removal confirmation. Bound branch labels so headers fit at minimum width. Worktree removal keeps the branch; session removal preserves the worktree and its files.
- Validation: `npm run check` passed (302 tests, both type checks and both builds); `git diff --check` passed. The new multi-worktree integration fixture has bounded waits sized for concurrent Git test processes; it passed in the full suite and alone. Real temporary Git repositories cover creation, restoration, dirty removal, independent concurrent file writes, Files/Terminal paths, Timeline attribution and durable history. Focused controller/host regressions cover late workspace replies and stopping one session without stopping another. Chromium fixture checks cover mode selection/locking, shared and isolated headers at 980 × 600 and 1360 × 860, no document overflow and dirty-removal confirmation.
- Not performed: live provider turns, real remote publication, or packaged application checks. Git worktrees isolate working files; shared sessions can edit the same files. In-app worktree merge/apply and automatic cleanup remain outside this port. See [concurrent sessions](concurrent-sessions.md).

# Desktop performance improvements (2026-10-19)

- Replace full execution-history rewrites with flushed append-only transactions, indexed journal/usage reads, legacy migration and torn-tail recovery. Preserve persistence-before-delivery and interrupted-run recovery.
- Scope transcript updates to their conversation, retain completed turns, fold new events incrementally, page older messages and journals, and bound session-cache payload. Publish local sessions before model discovery; cache catalog results, cap discoveries at two and evict settled overflow after bursts.
- Share Timeline watches, filter ignored event batches, cache private index stat data and reduce healthy root probes. Skip hidden-window tool polling and back off unchanged Changes reads.
- Validation: `npm run check` passed (283 tests, both type checks and both builds). The final cache-eviction regression and existing cache test passed separately (284 distinct tests in the resulting suite). Chromium checks passed for unrelated-event isolation, paging and retained turns during streaming; `git diff --check` passed. Local benchmark results and remaining limits are recorded in [performance improvements](performance-improvements.md). No live provider turn or packaged-app profiling was performed.

# Performance investigation (2026-10-19)

- Add [the desktop performance audit](performance-audit.md), ranking execution-history rewrites, transcript rebuilds, background Timeline captures, startup model discovery, eager history loading and Changes polling.
- Validation: benchmarked the actual storage adapter on synthetic histories and a disposable local-history copy, the session renderer in isolated Chromium, and Timeline captures in temporary repositories. The 69.29 MB history copy took a median 954.11 ms per event append; the original data was not modified. The private copy was deleted. Findings distinguish measurements from source-based hypotheses.
- Documentation only; optimizations, live provider profiling, tests/builds and pending pushes/merges were not performed in this investigation.

# Docked side chat layout (2026-10-19)

- Fix the empty band between a PR review and its docked side chat. With the chat docked, the review's 900–1000 px width caps are lifted and it fills the space beside the chat; header actions align to its right edge. Undocked, the reading width is raised to 1,240 px.
- Widen the docked chat from a fixed 380 px to a default 460 px. It is resizable from its left edge (saved per device, double-click resets) and clamped so the review keeps at least 520 px. Give side-chat questions an explicit bubble style so they render as bubbles in every palette.
- Validation: `npm run check` passed (276 tests, both TypeScript configurations, headless build and desktop bundle). In Electron at 2048 × 1066 and 1360 × 860, the review fills to the chat with no gap, dragging the divider resizes from 460 to 699 px and persists, double-click resets to 460 px, and the narrow window clamps the chat with no page overflow.

# Side chat, Explain with AI, Open in Timeline and Timeline UI (2026-10-19)

- Add **Side chat** ([details](side-chat.md)): a read-only conversation beside the main session and docked beside PR reviews. It is a standalone chat session run with `read_only` permissions, so it never takes the project writer lock or interrupts the main run. It carries bounded hidden context: recent session messages and the project path, or PR metadata, description and per-file patches. It has its own model picker, streaming, Stop and New side chat. Escape inside it stops only its own reply. A session-header icon and the right-panel launcher open it. There are no host, contract or core changes.
- Add **Explain with AI** to PR reviews: it docks the side chat and asks the selected model to explain the PR. Make **Open in Timeline** a labeled primary action.
- Fix Open in Timeline failing ("Git fetch failed") when reviewing as a GitHub account other than gh's active login. Git fetches now authenticate as the review's credential through a host-scoped `http.extraheader` passed via `GIT_CONFIG_*` environment variables, never argv or config. Verified live on a private repository visible only to the inactive account.
- Overhaul Timeline UI:
  - Two-line history rows: kind icon and word, message, file count and relative time.
  - Labeled icon buttons for Import timeline and Choose a repository folder.
  - Snapshot window: header with commit chip and readable date, a compact newer/change/older toolbar, an icon toggle for Diff, Before/After and Full context, and count badges.
- Validation: `npm run check` passed (276 tests, both TypeScript configurations, headless build and desktop bundle); `git diff --check` passed. New tests cover side-chat prompt bounding, visible-text separation, PR context content and patch omission, and per-provider fetch authentication. Live Electron checks covered:
  - The session side chat: header button, tool tab, suggestions, read-only badge and no-provider guidance.
  - Explain with AI docking beside a PR with the PR context, in the inbox.
  - Open in Timeline on `ketiyohannes/yomu` #1 (50 changed files), opening the snapshot window.
  - Timeline rows and the snapshot window in Diff and Before/After modes.
- Not performed: live provider runs in a side chat (the disposable test profile has no provider account; running against real accounts would use the user's subscription); approval/question prompts inside side chats (not shown there, documented as a limitation); GitLab/Bitbucket fetch authentication against live hosts.

# Pull request review overhaul (2026-10-19)

- Fix PRs failing to open when their raw diff exceeded 2 MB (seen live on a PR whose diff is 9.7 MB). GitHub now reads per-file changes from `/pulls/{id}/files`, and GitLab maps `/diffs` per file. Each file reports host counts; patches the host omits are labelled per file. Bitbucket raw diffs over the limit are cut to whole files and marked shortened, and GitHub's 406 "diff too large" degrades the same way. New contract field `PullDetail.files` (`ReviewFile`) is preferred over `diff` when present.
- Structure Activity: `ReviewComment` gains `kind`, `state`, `path` and `line` instead of embedding `[APPROVED]` or `[path:line]` prefixes in the body. Container-only and pending GitHub reviews and GitLab system notes are omitted.
- Rebuild the shared review renderer:
  - Markdown descriptions and comments, with a collapsible long description.
  - State badge, branch chips, icon actions, and tab icons with counts.
  - Check outcomes as icon plus word, with a summary.
  - Themed per-file diffs reusing the Changes styles, plus file status icons and a search field.
  - Icon-plus-label Submit review, Merge and Close/Reopen buttons.
  - Loading and error states with spinners, icons, Retry and Open on code host.
- Align the repository page with the inbox. Add a back icon, provider/branch/connection icons, the inbox row design and a state-specific empty state. Rebuild New pull request with labeled fields, a smarter default target branch, a labeled draft toggle, labeled actions, and separate progress and error lines. Replace raw `window.open` calls with the controller's external-link path. Replace hard-coded state colors with palette tokens. Fix a file-name ellipsis that rendered `.gitignore` as `gitignore.`.
- Validation: `npm run check` passed (272 tests, both TypeScript configurations, headless build and desktop bundle); `git diff --check` passed. New tests cover per-file GitHub changes including omitted patches, structured review activity, and whole-file truncation of an oversized raw diff. Live Electron checks with both signed-in GitHub accounts covered:
  - Opening the 9.7 MB-diff PR, which previously failed, with 35 files listed.
  - A PR with two passing checks.
  - Markdown descriptions, the collapsed description toggle, Code and Activity tabs, and light and dark modes.
  - The repository page for a disposable project pointed at `ketiyohannes/yomu`, including its PR detail.
  - New pull request form validation.
- Not performed: submitting reviews, merging, closing or creating PRs on live repositories (consequential remote actions); GitLab or Bitbucket live accounts; other palettes beyond the default in both modes.

# GitHub browser sign-in, type scale and launcher cleanup (2026-10-19)

- Fix GitHub account discovery. `gh auth status --json hosts` reports the username as `login`, but Rack read only `account`, so it found no gh logins. Both fields are now accepted, and test fixtures use gh's real output shape.
- Replace GitHub token entry with browser sign-in. `GitHubBrowserLogin` (new, `adapters/code-hosts/github-login.ts`) runs `gh auth login --web` without a TTY. It parses the device code and the same-host `https` verification URL, then reports completed, failed or cancelled. Cancel/close, a 15-minute limit and host shutdown stop gh. New commands `reviews.accountLoginBegin`, `reviews.accountLoginFinish` and `reviews.accountLoginCancel` replace `reviews.accountConnect`. Session-token GitHub identities and their `token` source are removed. A shared `components/github-sign-in.ts` dialog shows the code, copies it, opens GitHub and lists signed-in identities. It is used by the inbox and GitHub repository connections; GitLab/Bitbucket keep their token dialog. Credentials live in gh's keychain-backed store, so accounts persist across restarts.
- Retry each account's inbox search once before reporting it unavailable. Show "Checking GitHub accounts" instead of the sign-in prompt while discovery is pending. Restyle account warnings as an inset sans-serif card.
- Fix the repository connection icon button: it previously replaced its icon with text after rendering.
- Introduce a renderer type scale (10/11/12/13/14/16/18/22 px tokens) and map all 265 literal font sizes onto it, removing half-pixel and one-off sizes. Reduce the conversation content size from 15px to 14px and give code/diffs/Files/terminal a 13px code size.
- Remove the "Your workbench" heading, tagline and emblem from the blank tab launcher. Draw a single highlight for the selected session row.
- Validation: `npm run check` passed (270 tests, both TypeScript configurations, headless build and desktop bundle); `git diff --check` passed. New tests cover gh `login`/`account` parsing, device-code start and completion with environment-token isolation, foreign verification-host rejection, cancellation, token redaction in failures, hostname validation, command validation and search retry. Live checks used the installed gh 2.86.0: discovery found both signed-in accounts; the app inbox listed open PRs from both; a real `gh auth login --web` produced a code and `https://github.com/login/device` in the app dialog (browser opening stubbed); Cancel stopped gh with both existing logins unchanged. Electron screenshots reviewed the chat view, launcher, PR inbox, sign-in dialog states and Settings; every rendered element uses a scale size.
- Not performed: completing a new authorization in the browser, GitHub Enterprise sign-in, packaged-app runs (Finder launches may not include Homebrew's `gh` in PATH; `resolveShellPath` exists but is not wired into startup), or light-palette screenshots for this change.

# UI overhaul (2026-10-19)

- Branch `feat/ui-overhaul` from `feat/desktop-tools-and-scaling`. Keep the existing five palettes, light/dark/system modes, bundled fonts, project-only navigator and framework-free renderer.
- Refine the shell, project/session rows, conversation spacing, composer, tool panels, Settings, Usage and review pages. Add working project/session/account entry actions to the welcome state. Present the blank workbench as a named, tooltipped six-icon grid; remove preview-only Retrospective/Orchestration entry points.
- Use accessible Phosphor icons for routine composer, editor, saved-account, review and Timeline actions. Preserve readable choices and consequential form decisions. Include current permission/account values in tooltips. Save/reload retains dirty-draft confirmation, keyboard saving and version checks.
- Fix composer control wrapping/clipping and warning-icon expansion. Questions, approvals, catalog warnings and completed-plan actions now share a bounded stack above the prompt, preserving the input and send/stop row even at minimum prompt height. Improve muted neutral-text contrast and reduced-motion behavior.
- Complete Settings with existing-shortcut documentation and an About pane using the built package version and live host status. Omit unimplemented settings. Contain/restore focus, make the background inert, support radio arrow keys, skip hidden/inactive controls in focus loops, and add keyboard focus/navigation plus toggle behavior to the tool-tab menu.
- Validation: all 267 existing tests passed; final renderer/Node type checks, headless compilation and desktop bundling passed. `git diff --check` passed. Isolated Electron review used disposable data and a disposable project: all five light/dark palettes; Settings focus wrapping/restoration, appearance selection, Accounts/Models/Plugins/Shortcuts/About; permission and tool menus; file browse/edit/save; terminal input; local browser navigation; Timeline and Changes; Usage and PR inbox presentation. Geometry assertions at 980 × 600 with a 148px prompt, a long draft and synthetic stacked requests confirmed no document overflow, visible prompt/send controls, independently scrolling draft and a bounded request stack. No renderer errors were reported.
- Not performed: provider sign-in, paid/live agent turns, submitting remote reviews/PRs, external editor launches, or packaged Windows/Linux review. Existing host permissions, routing, persistence and tool-resource lifetimes are unchanged.

# Sidebar correction (2026-10-19)

- Start the right workbench with one blank New tab containing the original surface list. Keep the + dropdown for another blank tab or a chosen tool; launcher choices fill the current blank. Enabled plugins and old tab preferences no longer pre-open tools. Reuse existing tool instances and restore a blank tab after the last close.
- Restore the left project navigator and its shared scroll area. Remove New chat, Chats list and their added resizing UI; retain standalone chat services, controller operations, persistence and the main conversation experience.
- Validation: both TypeScript configurations and desktop bundling passed; all 20 focused chat-controller/sidebar-order tests passed. Disposable Electron checks confirmed one blank tab despite saved tool preferences, the full launcher including disabled/preview tools, launcher choices replacing their blank tab, + dropdown blank/tool creation, last-tab reset and retained terminal instances. Confirmed the left chat controls/divider are absent. Earlier broader checks below apply to the preceding implementation.

# Desktop scaling, editor launch and integrated tools (2026-10-18)

- Implement on `feat/desktop-tools-and-scaling`, branched from current `dev`. Use a shared 15px content font for prompts, bubbles, replies, inline/fenced code, tool output, diffs, Files and terminal text; retain compact metadata/navigation.
- Add **Open in** menus for project/chat folders and selected files. Detect common installed editors including VS Code/Insiders, Cursor, Windsurf, Zed, Sublime and JetBrains editors, with a native chooser for other installations. Validate editor IDs and targets in main, pass literal argument arrays and preserve the original target across navigation.
- Restore the original xterm renderer with bundled CSS, a flush viewport and compact Restart/Close shell actions. Keep existing host/Codex PTYs, cancellation and reconnect behavior. Wait for the actual font, buffer output before terminal attachment, retain focus on session updates, and apply the app palette.
- Replace the right-panel launcher with persistent, keyboard-accessible tool tabs, a + picker and close actions that retain tool state. Bound chat history and drafts to independent scrolling regions, add a saved horizontal prompt-height splitter, detach the native browser during splitter drags, give the left Chats list its own saved height and scroll area, and compact the New chat action.
- Consolidate Browser into one navigation/omnibox row above the native page, with search, back/forward/reload, pause/resume and close. Keep shared agent control, handle address submissions during a busy control request, route Cmd/Ctrl+L from native website to trusted chrome and scale native page bounds with app zoom. See [desktop tools](desktop-tools.md).
- Validation: `npm run check` passed (267 tests, both TypeScript configurations, compilation and desktop bundling). Final focused editor/browser/controller checks passed (23 tests), followed by final types/builds and `npm run test:desktop-features`. Native UI checks used disposable app data: equal computed 15px prompt/prose/code/Files fonts; installed VS Code/Cursor discovery; recorded folder/file launch targets without starting external editors; real key-driven PTY input/output; single browser toolbar and agent form interaction; pause enforcement; bounds alignment at 80%, 100% and 125%; and native-page address focus. Final layout checks covered pointer-driven sidebar/prompt/Chats splitters, tab addition/close/reopen and keyboard navigation, retained PTY output and unsaved Files drafts, restored layout preferences, independently scrolling long history/drafts, 125% zoom with no document overflow, and browser detachment during resizing. Native Chromium/local/Codex PTY smoke checks passed again after the terminal restoration. Live editor process launches, packaged Windows/Linux builds and authenticated model-driven browsing were not exercised.

# General chat, Plan mode and installed skills (2026-10-16)

- Implement on `feat/chat-plan-skills`. Add project-free Chats, separate composer drafts, automatic titles and private file workspaces. Reuse attachments, accounts/models, Browser and terminal lifecycle. Attach a project later while preserving visible history, keeping original chat files accessible and resetting native continuation/cwd state.
- Add independent Plan workflow controls, native provider planning policies and enforced read-only app tools. Persist plans in the conversation and offer Revise/Implement. Validate the latest saved same-session plan at execution time; explicitly restore normal native mode only for a later user-submitted turn.
- Add searchable installed-skills selection and `/` access, source/disabled/error presentation, per-account/runtime/project selections and fresh host-side ID validation. Use Codex native discovery/input and Claude skill-only native plugin/slash invocation, preserving resources and account isolation. Include installed Claude plugin skill folders with project scope filtering.
- Upgrade sessions/execution to schema 4 without rewriting prior histories. Reserve chats against concurrent starts; preserve project writer checks. Guard late project model discovery during chat navigation and refresh shell/skill contexts on attachment. Update effective Plan permissions in run diagnostics. See [usage, sources and contracts](chat-plan-skills.md).
- Validation: `npm run check` passed (258 tests, both TypeScript configurations, headless build and desktop bundle). After final guards, 57 focused execution/provider/host/storage checks and 23 navigation/persistence/skill checks passed; final type checks and builds passed. Real Electron smoke checks passed for Chromium, local/Codex PTYs and project-free chat persistence, safe Files operations, private terminal cwd, Browser and deletion cleanup. Browser fixtures exercised New chat, skills selection/disabled entries, slash access, Plan submission, saved-plan restoration/implementation and project attachment. Installed Codex skill discovery and Claude native plugin command discovery were probed without a model turn. Authenticated live model turns, paid file-generation/research workflows and packaged platform builds were not exercised.

# Integration with current main (2026-10-16)

- Merge the PR/Usage/session-recovery work with main through `d3e00f6`, preserving the provider diagnostics, Windows Codex executable resolution, native window controls, diagnostics drawer and desktop spacing/splitter improvements from the recent PR.
- Combine provider control-request deadlines and stdin error handling with bounded process-group shutdown; keep single-instance startup alongside the new native window IPC handlers. Retain both stylesheet additions, with main's UI rules last.
- Validation: `npm run check` passed (250 tests, both TypeScript configurations, headless build and desktop bundle). Twelve focused diagnostics/resolver/shutdown tests passed, including the new deadline/cleanup regression. `npm run test:desktop-features` passed on retry (the first attempt timed out on native form input during the full-suite run). Verified all 22 upstream-only files are byte-identical to main; all other additions from recent main commits remain verbatim except the deliberately combined transport shutdown. Live authenticated providers and a packaged Windows build remain untested.

# Account-wide GitHub PR inbox (2026-10-16)

- Keep work on `feature/pr-support`. Replace the project-required PR landing page with a compact inbox inspired by T3's involvement filters and review tabs. Aggregate all connected GitHub CLI/environment/session-token identities, including multiple users on the same host; show account, involvement and status filters, search, deduplicated rows and load-more results.
- Add explicit per-account reads, reviews and creation without global CLI account switching or credential fallback. Keep GitLab/Bitbucket repository workflows and branch publishing. Share Overview/Code/Activity review UI, retain drafts and decisions by identity, and resolve exact local repository matches only for Timeline.
- Expose partial/total account failures, incomplete search and GitHub's 1,000-result limit. Tokens remain host-memory-only; CLI credentials remain in gh. See [usage and limits](pull-requests.md).
- Validation: `npm run check` passed (237 tests, both TypeScript configurations, headless build and desktop bundle). After the final UI guards and reviewed-by search lane, `npm run typecheck`, `npm run build:desktop` and focused provider/Git/inbox tests passed (18 tests). Populated browser fixtures covered no-project inbox navigation, two accounts, equal PR numbers across repositories, late-result rejection, per-account drafts/decisions, Code/Activity/file filters, review submission identity, explicit refresh, Timeline folder registration/targeting, account-specific draft creation, explicit branch publishing, load-more deduplication and disconnected/error states. Read-only discovery found zero connected GitHub accounts here, so live authenticated aggregation and mutations remain unverified. Packaged distribution and live Enterprise deployments remain untested.

# Interrupted-session recovery and confirmed running-session deletion (2026-10-16)

- Fix abandoned queued/running records and stale project writer locks surviving restart as perpetual chat loading dots without a live Stop target. Startup atomically marks uncertain outcomes and journals recovery before host readiness. Preserve completed runs, continuations and partial output; never replay automatically.
- Bound provider cancellation, stream/iterator cleanup and application quit. Close owned Codex processes even during initialization, reject pending RPCs and terminate their POSIX process groups; close owned Claude queries. Ignore late output, close event drains even on persistence failure, reject starts during shutdown and prevent duplicate desktop owners for the same profile.
- Enable deleting running sessions through an explicit **Are you sure? / Stop and delete session** modal. The host stops and settles execution before removal. A run starting after the modal opens requires a new confirmation; ordinary deletion keeps its busy guard.
- Validation: the 225-test full suite passed, followed by 59 targeted execution/runtime/host/renderer checks for final shutdown-race and persistence-failure guards. Type checks and headless/desktop builds passed. Real subprocess tests verified pending-RPC rejection and owned-child termination; `npm run test:desktop-features` passed for Chromium, local PTY and Codex standalone PTY. Isolated Electron checks verified orphan recovery without dots/locks and ordinary deletion; renderer fixtures verified the running-session warning, confirmed force parameter and second-confirmation race. Live model turns, hard OS termination and packaged distribution were not exercised.

# PR support, Usage and footer navigation (2026-10-16)

- Branch: `feature/pr-support`. Move notices to bottom left above the sidebar footer; use icon-only Settings, Usage and Pull Requests navigation.
- Add real provider adapters for GitHub, GitLab and Bitbucket Cloud, repository selection, PR search/filter/pagination, diffs, discussion/reviews, checks, draft creation, explicit branch publishing and guarded review/merge/close/reopen controls. See [capabilities and provider boundaries](pull-requests.md).
- Connect PR comparisons to existing Timeline history/viewers through isolated, persistent hidden refs, refresh changed PR versions and retain prior comparisons. Add a Timeline-to-PR shortcut.
- Add Usage analytics from a minimal execution audit projection, with project/period filters, daily activity, model/provider totals and explicit usage coverage. Pause hidden workbench/native-browser surfaces when full pages are open.
- Validation: `npm run check` passed (216 tests, type checks, headless build and desktop bundle). Targeted provider/Git/Usage/Codex tests passed. Electron checks covered footer navigation, empty Usage/PR states and the offline toast position; populated renderer fixtures covered PR details, file presentation, draft retention, pagination, creation/publishing inputs, Timeline targeting and Usage filters/metrics. Live remote mutations, enterprise deployments and packaged distribution remain untested.

# Change log

## 2026-10-16 - Restore sidebar app name

- Restored the `thinking & code` wordmark and its original header spacing below the menu bar. The duplicate native window title remains hidden.
- Validation: type checks and desktop build passed; no new native-window visual check performed.

## 2026-10-16 - Changes spacing and panel resize follow-up

- Inset Changes empty/loading/error messages by 16px. Splitters now start from the displayed width rather than an oversized saved preference after window shrinking. Fit both panels together, widen the grab area to 10px, and clear drag state on lost pointer capture.
- Validation: type checks, desktop build and whitespace checks passed. Browser checks at 980px confirmed a 20px drag changes panel width by 20px after shrinking from 1400px with a saved 700px panel; keyboard resizing, message inset, released cursor and absence of horizontal overflow passed. Native OS pointer interruptions were not tested.

## 2026-10-16 - UI spacing, connection drawer and themed menus

- Moved connection tests and results into an on-demand drawer sliding in from the right. Quiet Connection details actions keep the account list compact. Escape closes only the top modal, including while its focused action is disabled; focus returns to the trigger. Reduced motion disables the slide animation.
- Adjusted settings, account cards, dialog headers, buttons and tool-panel padding, gaps and borders. Hid the duplicate Windows/Linux window title while retaining the sidebar wordmark. File/Edit/View/Help now follows the app palette while keeping native caption controls. Main validates the narrow action/color bridge; macOS keeps its existing native chrome.
- Validation: type checks and desktop build passed. Browser checks with a simulated host covered dark/light palettes, 980px layouts, long diagnostic paths, pending/results states, drawer focus/Escape, reduced motion, menu keyboard navigation and theme/action bridge calls. Screenshots reviewed. The native Electron smoke attempt did not complete and was stopped; native caption rendering and menu effects, macOS/Linux and packaged execution remain unverified. Earlier full-suite baseline failures are recorded below.

## 2026-10-16 - Provider setup and account diagnostics

- Added explicit Test connection actions in Settings > Accounts. Connections validates provider/account ownership and coalesces checks; adapters report executable location, parsed version, startup status and optional local sign-in state through the provider-neutral `auth.diagnose` command. Installation-only probes use disposable configuration, account checks use isolated saved contexts, and results never change selection or availability or start model turns. Raw CLI output and credentials are excluded from diagnostic results.
- Added native Windows Claude discovery through PATH and the standard user install location. Codex startup/control requests have bounded deadlines, and transport close settles pending requests. CLI probes bound output and process lifetime; long-running model work is unaffected. Reconnects invalidate old UI observations and reject stale in-flight results.
- Validation: type checks, headless/desktop builds, 34 focused adapter/core/controller/host tests and whitespace checks passed. Real installed Codex and Claude setup checks passed; both reported signed-out state against disposable empty account contexts. Browser checks with actual renderer/controller modules and a simulated host covered success, failure, disabled pending actions, correct account routing, long executable paths and narrow/light/dark layouts; screenshots reviewed.
- Full-suite run: 198 passed, 20 failed out of 218. A clean export of the pre-feature commit reproduced 20 failures (190 passed out of 210), involving existing Windows filename/path/permission assumptions and repository/Timeline fixtures. These unrelated failures were not changed. Authenticated account checks, model turns, macOS/Linux execution and packaged Electron verification were not performed.

## 2026-10-16 - Codex account launch on Windows

- Fixed bare-command executable discovery behind `spawn codex ENOENT`. Sign-in, model discovery, runs and Codex terminals now share native Windows CLI discovery through PATH and the standard per-user npm prefix, supporting nested/hoisted platform packages and bundled vendor layouts without a shell. Missing installations produce an actionable error; explicit commands and non-Windows behavior are preserved.
- Validation performed: type checks, 13 focused resolver/runtime tests, desktop build and whitespace checks passed. A real installed Codex server initialized successfully with a stripped-down PATH and disposable isolated CODEX_HOME. Full browser sign-in, an authenticated model turn, packaged Electron launch and the complete test suite were not performed.

## 2026-10-15 - Complete Terminal, Browser and Files

- Finished the three interactive surfaces and their host/runtime wiring. Terminal reconnects to context-owned PTYs, prefers Codex's standalone command API when available, falls back to a local PTY, orders input, resizes and exposes exit status. Fixed xterm initialization before DOM attachment, pending-start cleanup, session-removal retention, cancelled-unload cleanup and native Unicode chunk decoding.
- Browser owns isolated session pages with navigation, pause/resume and user/agent interaction, including selects and keyboard submission in detached views. Snapshot refs are unique across pages/navigation; isolated-world errors stay actionable. State polling no longer creates unused pages, and lifecycle controls remain user-owned. MCP listeners authenticate, decode bounded UTF-8 requests and close on cancellation/settlement, including fresh and resumed provider sessions.
- Files browses project directories and explicitly saves existing UTF-8 files. Added accessible file buttons, dirty-reload confirmation, stale-read guards, preserved executable permissions, special-file rejection and serialization for equivalent save paths. External changes retain drafts and return a conflict.
- Browser tools now follow the existing permission contract: Read only denies mutations, Ask uses the app broker, Auto preserves provider review without a Claude allow-list bypass, and Full access runs directly. Fixed a cancellation deadlock by releasing pending approval waiters before native shutdown.
- Added automated service, filesystem, runtime-adapter, MCP and permission/cancellation regressions plus `npm run test:desktop-features` for actual Chromium, local PTY and Codex standalone PTY checks against disposable data, without a login or model turn. Usage, retention, limits and architecture are recorded in [desktop tools](desktop-tools.md).
- Validation performed: the complete 206-test suite (20 new cases), type checks, headless/desktop builds and whitespace checks passed; targeted execution/host/MCP regressions also passed after the cancellation fix. Native Electron checks passed for isolated Chromium forms, stale refs, keyboard submission, cookie isolation, pause/resume and view attachment, real local PTY cwd/input/resize/reconnect/exit, and a real Codex standalone PTY without a login or model turn. The installed MCP SDK completed an HTTP handshake, discovery and tool execution. Actual renderer/host checks with disposable data/profiles covered file save/conflict/discard/draft retention, accessible rows, terminal output and session reconnection, shared user/agent browser actions and pause. Screenshots were reviewed; Chromium background-rendering flags were used for occluded-window QA. Authenticated model-driven browsing and packaged distribution were not performed.

## 2026-10-15 - Session removal and Timeline navigation

- Added a trash action on hovered/focused session rows with a confirmation dialog, Cancel initially focused, retryable errors and disabled removal during active runs. `sessions.remove` removes Rack's saved conversation/continuation record and broadcasts `sessions.removed`; clients evict cached history, reject stale loads and clear only the removed session's selected chat. Execution audit records, attachments, Timeline snapshots, project files and provider history retain their existing retention behavior; this is not a purge.
- The host serializes removal, run starts and attachment imports per session, including the gap before a starting run is tracked. Active or persisted queued/running runs return `session_busy`. Durable storage and regression tests cover restart persistence, sibling preservation, concurrent start/remove ordering, retained audit, stale list/journal exclusion, and background removal without stealing selection.
- Timeline's repository chooser previously called project navigation and cleared the current conversation. It now changes only the panel's query target, reusing/registering project records without selecting them. Repository history, file diffs, recording controls and expanded snapshots use that target; This session still uses the selected chat. A repository label and Back to project action identify the local view. Launcher actions are explicitly non-submitting buttons.
- Validation: type checks, all 186 automated tests, headless/desktop builds and whitespace checks passed. Browser checks used actual shell, controller, navigator, composer, chat and workbench modules with a simulated host: confirmation/cancel, retry, selected/background removal, focus restoration, disabled active removal, Timeline launcher/shortcut, existing/new repository browsing, delayed registration, correct snapshot target, This session scope, preserved messages/draft and narrow sidebar/panel layouts. Light/dark screenshots were reviewed. No actual saved sessions were removed, and native Electron/provider checks were not performed.

## 2026-10-15 - Session loading performance

- Found repeated whole-database copies during journal/run reads, current-session-only transcript caching, and waiting for all journals before rendering messages. Added detached JSON read projections, an eight-session renderer cache, early message publication, terminal-run version checks, and host-revision guards. Same-project session switches reuse the model catalog.
- A read-only sample of the actual 23.2 MB execution store (68 runs, 22,539 journal entries) compared six whole-database-copy queries with six projected copies: 591.1 ms versus 28.0 ms. This isolates storage copy/filter work; it is not an end-to-end screen latency claim.
- Validation: regression tests cover immediate cache restoration without journal replay, early messages before slow journals, stale-session response exclusion, changed-run invalidation, detached storage ownership and bounded eviction. The complete 177-test suite, type checks, headless/desktop builds and whitespace checks passed. Browser checks with the actual renderer modules and a simulated host confirmed immediate warm restoration with no journal reads, early cold-session messages before a delayed journal, and later activity hydration.

## 2026-10-15 - Claude and Codex interactive questions

- Added provider-neutral pending questions and answer/dismiss routing through Execution, the host, IPC and renderer. Questions support choices, multi-select and custom text, remain independent of permissions, survive renderer reconnects, and settle on cancellation. Invalid or repeated answers cannot resolve another request. Secret values are redacted from normalized journal/broadcast answer events.
- Claude maps `AskUserQuestion` answers back through `canUseTool` in all permission modes while preserving native action policies. Codex handles `item/tool/requestUserInput` (and its legacy method spelling), keeps consuming notifications for nonblocking questions, and clears native-resolved requests without stale replies. The installed Codex app-server's generated protocol was checked alongside official provider docs.
- Added persistent question forms above the composer, draft/focus preservation during streaming and session switches, readable answer history, and a Needs input sidebar indicator.
- Validation: adapter, core broker, transport and host tests cover native answer shapes, automatic permission modes, continued Codex output while pending, native resolution, answer validation, secret redaction, client snapshots, cancellation and writer release. The complete 177-test suite passed; after adding cancellation-journal draining, all 33 focused adapter/broker/host tests passed, including the new shutdown regression. Type checks, headless/desktop builds and whitespace checks passed. Browser checks with actual renderer modules and a simulated host covered initial pending snapshots, streaming focus, drafts across session switches, Enter isolation from the composer, retry after failure, exact multi/custom answer payloads, dismissal, masked inputs, redacted history, and light/dark/narrow layouts. Visual review caught and corrected inherited full-width choice controls. No authenticated provider turn or native Electron check has been run.

## 2026-10-15 - Compact Timeline sidebar lists

- Matched Timeline's history, repository-choice, and nested file/folder rows to Changes: 13 px text and 31 px rows. Checkpoint summaries use one line, with long labels truncated and full details in tooltips. Snapshot-opening buttons fit inside the compact rows.
- Validation performed: type checks, desktop bundle, and whitespace checks passed. Browser measurements with actual renderer modules and simulated host data confirmed history, repository, file and folder rows match Changes at 13 px/31 px, including the 260 px sidebar without overflow. Screenshots reviewed; Timeline code remains 14 px. Expanded-view typography and diff colors retain their behavior. Native Electron checks not performed.

## 2026-10-15 - Timeline repository chooser and change stepping

- Unsupported container projects now show discovered repository folders as clickable choices, plus Scan deeper, empty/limited-scan messages and recoverable errors. Choosing a folder selects its existing project or registers and selects it normally, then shows Timeline. Unsupported session views link to the chooser. Polling preserves keyboard focus, stale discovery replies cannot cross projects, and delayed folder registration cannot steal a newer selection.
- Expanded Timeline windows now have a prominent bordered Change selector, newest-first position counter and up/down buttons for newer/older entries. End buttons disable; rapid stepping uses existing stale-load guards, keeps file/view selection, and history refresh retains the current known target.
- Validation performed: type checks, all 43 renderer tests (including new project-opening and delayed-registration coverage), desktop bundle and whitespace checks passed. Browser checks with actual renderer/controller modules and a simulated host covered visible folders, existing-project reuse, new-project registration, deeper scans, error recovery, focus across polling, stale discovery rejection, dropdown selection, stepping boundaries, file/view preservation, rapid out-of-order reads, current-target retention on refresh, and narrow layouts. Dark/light screenshots reviewed. Read-only discovery of the actual workspace returned `rack-code` and `rack-code-concurrent`. Native Electron/provider checks not performed.

## 2026-10-15 - Timeline typography and stronger diff colors

- Changed Timeline's interface from IBM Plex Mono to larger Inter text: 14 px body/file rows and 16 px panel heading. Expanded-view metadata and controls are larger too.
- Added pinned, locally bundled Geist Mono for code, chat code blocks, tool output, and diffs, with its OFL license. Timeline code is 14 px and Changes code is 13 px; UI metadata retains its own font.
- Strengthened green/red diff backgrounds in all palettes and appearances, with colored edge markers and heavier colored line numbers for additions/deletions in inline and split layouts. Timeline previews, expanded snapshots, and Changes share these styles; Before / After retains its existing added-line behavior with stronger green.
- Validation performed: Node/renderer type checks, desktop bundle, and whitespace checks passed. Browser checks with actual renderer modules and simulated host data verified local Geist Mono loading and equal glyph widths, Timeline's sans UI/code fonts and larger sizes, 260 px layout without page overflow, neutral/Flexoki light/dark fill colors, inline/split Changes markers and heavier line numbers, and the expanded snapshot viewer. Screenshots reviewed for Timeline, Changes inline/split, and expanded snapshots in light/dark. Native Electron and provider checks not performed for these presentation changes.

## 2026-10-15 - Larger plugin sidebar, monospaced Timeline, and Flexoki

- Increased right-sidebar launcher/header text and icons across all surfaces and plugin previews, plus Changes/Timeline file rows, diffs, and Run details. Increased control/row heights; Timeline summaries and scope tabs adapt to narrow panels.
- Timeline and its expanded snapshot viewer now use bundled IBM Plex Mono for headings, content, and controls.
- Added Flexoki to Settings > General with paired light/dark previews, persisted palette selection, System appearance support, and matching Git diff/status accents. Colors derive from [Flexoki by Steph Ango](https://stephango.com/flexoki); secondary text uses a stronger base shade for legibility.
- Validation performed: Node/renderer type checks, desktop bundle, and whitespace checks passed. Browser checks used actual renderer modules and a simulated host: verified every preview plugin's larger headings/icons/body, Timeline's mono font and 260 px layout without page overflow, the five-palette picker, Flexoki light/dark colors, live System-mode changes, and palette/mode persistence across reload. Screenshots reviewed for the launcher, Settings in both modes, and narrow Timeline. Full host/provider tests and native Electron verification not performed for these presentation changes.

## 2026-10-15 - Project folder session count placement

- Moved each project folder's session count after the database import and plus buttons, with trailing spacing and a non-shrinking count. Collapsed folders retain their running/approval indicators in the same trailing position.
- Validation performed: Node/renderer type checks, desktop bundle (`node --import tsx scripts/build-desktop.ts`), and whitespace checks passed. The npm build wrapper hit the sandbox's socket restriction, so the same build script was run directly. Live Electron verification not performed.

## 2026-10-15 - Starred model favorites

- Added Settings > Models with the full discovered catalog grouped by provider and accessible star/unstar buttons. Favorites persist per device under `models.favorites`, keyed by provider/runtime/model rather than label or account. Unavailable favorites remain saved across catalog/account changes. Keyboard focus stays on the toggled star, and Settings reports unavailable favorites or partial discovery failures.
- The composer now lists only available starred models. There is no automatic starring or unstarred fallback. Empty favorites offer Choose favorites and disable sending; removing the selected favorite chooses another available favorite or clears selection. Submission checks current favorite membership before sending, including the interval before DOM watchers update. Reasoning/Fast, catalog discovery and host routing retain their behavior.
- Validation performed: Node/renderer type checks, all 41 renderer tests and desktop bundle passed; whitespace checks passed. New tests cover malformed/deduplicated storage, provider/runtime identity, strict filtering/order, and restoring unavailable favorites after catalog/account-label changes. Electron verification used actual renderer modules with synthetic catalog/account data and an intercepted host boundary: confirmed star/unstar states and focus, favorites-only options without search, reasoning/Fast, routing parameters, persistence including an empty list, temporary catalog unavailability and recovery, selected-model removal, and blocking an immediate submit after unstarring. Screenshots reviewed with no page overflow. Not performed: full headless suite (renderer-only change), authenticated provider turns, or packaged build.

## 2026-10-15 - Timeline container projects and After highlighting

- Fixed this project's unsupported Timeline state: the saved folder is `rack-desktop`, while its Git repository is nested in `rack-code`. The snapshot adapter now reuses bounded Changes repository discovery when the selected folder is outside Git, accepts a single repository from a complete scan, and validates its canonical root within the container. History, exact-file reads, session capture and automatic recording share that resolution. Watchers observe the repository root; project/session identities and pause settings are preserved. Multiple repositories, incomplete scans and external child symlinks never silently choose a repository. Existing running desktop hosts need a restart to load the recorder change; current uncommitted edits are observed on startup.
- Before / After now highlights added and replacement lines in After using Git's new-side line numbers, with a green background, gutter and line number. Before and unchanged After lines stay plain. Shortened patches show a highlighting-unavailable notice while retaining exact full-source contents.
- Validation performed: `npm run check` passed (Node/renderer type checks, headless build, all 158 tests and desktop bundle), and whitespace checks passed. Added real-Git regression coverage for a container project's existing commits, dirty startup, live edits, exact versions, session recording, repository-root watching, unchanged HEAD/index, ambiguous repositories and external symlink exclusion. Added highlighting coverage for replacements, insertions, deletions, empty/unchanged patches and truncated patches. A read-only probe confirmed this project's actual parent resolves to `rack-code`. Native Electron checks used isolated container-project data and the production host/preload: verified live capture, exact versions and visible After highlights, unchanged Git HEAD/index, and 4,000-line full-source retention with an unavailable-highlight notice for a shortened patch; screenshots reviewed. No active user run was restarted. Not performed: packaged build or multi-repository Timeline selection.

## 2026-10-15 - Combined Timeline Before / After view

- Replaced the separate Before and After options in the expanded Timeline viewer with one Before / After option. Exact historical contents appear side by side, Before on the left and After on the right, with independent scrolling, line numbers and fixed headings. Missing, empty, binary and oversized versions have per-pane notices; each pane retains the 10,000-line render limit. Diff and Full context remain available, and navigating changes preserves the selected mode.
- Validation performed: Node/renderer type checks, desktop bundle and whitespace checks passed. Native Electron checks with an isolated real Git repository confirmed the three dropdown choices, exact modified-file versions and side-by-side layout, added/deleted/root-commit notices, empty and binary files, unchanged files through All files, independent horizontal/vertical scrolling with fixed headings and no page overflow, switching all three modes, retaining the split view across history navigation, and Escape dismissing the dropdown first. Screenshot reviewed. Not performed: full headless suite (renderer-only change), packaged build, or a new large-file limit stress check.

## 2026-10-15 - Permission default and color palettes

- The composer now starts with Approve for me. Explicit choices and the displayed permission mode of an active run retain their existing behavior; provider permission mappings are unchanged.
- Added Emerald, Burgundy, and Purple alongside Neutral in Settings, General. Each palette has coordinated light/dark surfaces, text, borders and primary accents, with paired previews. Light / Dark / System remains an independent choice. Preferences persist on this device; existing mode preferences keep Neutral colors. Open Timeline snapshot windows follow both palette and mode changes.
- Validation performed: Node/renderer type checks, desktop bundle, and whitespace checks passed. Electron checks with isolated test data verified the initial permission label, Neutral and all six colored variants, palette/mode persistence after reload, System switching under emulated light/dark preferences, and live synchronization to an expanded Timeline window. Reviewed light and dark screenshots and confirmed no horizontal page overflow. Not performed: the full headless suite (this change is renderer-only), authenticated provider runs, or packaged build.

## 2026-10-15 - Automatic project Timeline and viewer dropdowns

- Fixed projects with no existing Timeline missing subsequent edits: the desktop host now starts observers for saved Git repositories, including projects with no sessions. Initial uncommitted state compares against HEAD where available; unborn repositories establish a baseline. Debounced filesystem observations run outside agent runs, with five-second reconciliation/fallback for new projects or unavailable/closed watchers. One observer per repository root avoids duplicate chains from subfolder aliases. Project refs live under `refs/rack-project-timeline/`; HEAD, index and working files remain unchanged. Project Pause/Resume persists in an additive `timeline.json.projects` field, with old documents defaulting on. Headless reads do not start workers. Session opt-in remains independent.
- Added `timeline.snapshotHistory` and a Timeline change dropdown in the expanded viewer. It navigates project commits and observations across sessions without reopening the window; the initial session checkpoint is retained when older than the recent page. Replaced view buttons with a View mode dropdown for Diff / Before / After / Full context. Generation checks protect rapid navigation, selected file/mode are preserved when possible, and history refresh keeps the current comparison. Escape closes a menu before the window.
- Validation performed: `npm run check` passed (Node/renderer type checks, headless build, all 155 tests, desktop bundle); final UI type checks/bundle and whitespace checks passed. Five new real-Git tests cover existing dirty projects without sessions/import, unborn repositories, watcher closure fallback, newly registered projects, persisted project pause/resume, and same-project navigation across commits/sessions. Desktop checks used the production entry/host/preload with isolated temporary repositories; an occluded test window required a wrapper disabling background throttling only for QA. Confirmed initial uncommitted capture, live edits, edits in a never-opened sessionless project, Pause preventing capture and Resume recording current state, both dropdowns and their options, mouse/keyboard checkpoint navigation preserving file and Full context, Escape closing the menu without closing the viewer, no horizontal overflow, and unchanged Git HEAD/index bytes. Screenshots reviewed. Not performed: authenticated provider runs, packaged build, or large-repository measurements.

## 2026-10-15 - Standalone Timeline snapshot viewer

- Added expand actions to Timeline entries and file previews. They open separate native desktop windows with a collapsible Changed files / All files tree, a filename/path filter, and Diff / Context / Before / After modes. Context restores full-file unchanged lines around complete patches. Unchanged files, deletions, root commits and empty files are inspectable; absent sides explain their state. Each viewer keeps its own snapshot and selected file independently of the main chat. Escape closes only the viewer.
- Added `timeline.snapshot` / `timeline.snapshotFile` and the shell-only `openTimelineWindow` bridge. Main validates the app identities through the host and opens the fixed bundled sandboxed page. Timeline resolves authorized history membership and visible tree paths; the Git adapter reads immutable objects without checkout or symlink following. Contents are bounded at 1 MiB and rendered code at 10,000 lines; binary, submodule, symlink and size notices keep the tree usable. Truncated diffs never produce invented context highlights. No core/persistence schema changed.
- Validation performed: `npm run check` passed (Node/renderer type checks, headless build, all 150 tests, desktop bundle). Type checks and desktop bundle were repeated after visual adjustments; `git diff --check` passed. Seven added tests cover full context across hunk gaps, root additions/deletions and newline boundaries, unchanged/deleted file membership, exact historical contents after working-file edits, literal special filenames, visibility and cross-repository rejection, binary/oversized/symlink/empty-file handling, and host command validation. Native Electron verification used the production main/host/preload path and an isolated data directory with a real temporary Git repository. Confirmed expansion from entries and selected file previews, project/session viewers, full context and Before/After versions, All files and filtering, deleted/root/binary/empty states, independence from chat selection, invalid-target rejection, window closing, Git colors and no horizontal overflow; screenshots reviewed. HEAD, index bytes and the live working file stayed unchanged. Not performed: authenticated provider runs, a packaged build or large-repository performance measurement.

## 2026-10-14 - Timeline for existing project history

- Timeline now defaults to **Project history**, reading the current HEAD's first-parent Git history plus saved Rack/Codex/Relay timeline refs from every session in the repository. It works without a selected session or recording opt-in. Ordinary root commits show added files, snapshot baselines remain hidden, and hashes deduplicate entries reached through several refs. Git commits and run observations retain distinct labels and original session provenance when present. This is a read-only view; exact-session import and future recording remain under **This session**.
- Added `timeline.projectHistory` and `timeline.projectFileDiff`, the project-path read in `TimelineCoreAccess`, and bounded history/immutable comparison caching. Previews require current project-history membership and a currently visible changed path. Current ignore rules apply on every read. History reads the most recent 200 commits/snapshots, warns when bounded, polls every four seconds while visible, and offers manual Refresh. Folder rows now select projects without requiring a session while preserving the current session when toggling the selected folder.
- Existing session conversations alone cannot reconstruct unrecorded intermediate edits. Existing commits and actual saved snapshot refs are available immediately. Identical-tree grouping and an uncommitted working-tree history entry remain deferred.
- Validation performed: `npm run check` passed (Node/renderer type checks, headless build, all 143 tests, desktop bundle) and `git diff --check` passed. Six added integration tests use real temporary Git repositories to cover pre-existing/root commits and diffs without opt-in, cross-session and Codex/Relay-ref discovery without an index, deduplication, current ignore rules, unrelated revisions/paths, bounded reads, external refresh, unborn repositories, host dispatch and input validation, and preservation of HEAD/index/files. Electron checks with the real host and temporary repositories confirmed Git/run provenance, saved snapshot and commit previews, project selection with no sessions, switching projects, non-Git messaging, filtering, external-commit polling, recording remaining disabled, unchanged HEAD/index, and no horizontal overflow at the default panel width; screenshots reviewed. Not performed: authenticated provider runs, a packaged build, or large-repository performance measurement.

## 2026-10-14 - Compact thinking into tool-call groups

- Consecutive activity now compacts into one collapsed group: tool calls, unpaired tool outputs, and the thinking traces or summaries between them. Previously every thinking item ended a group, so a run alternating between thinking and tools showed many small groups and open traces. Only reply text and status messages break a group now. The group row counts tool calls and thoughts, aggregates tool status, and reads "Thinking" while an active run's newest item is a trace. Expanding it shows each call and trace in order with their existing disclosures. Live, saved, and imported history use the same rule.
- A lone tool call, and thinking with no tool calls (for example reasoning before a reply), stay standalone, so that reasoning is still visible by default. Group keys keep their earlier prefix, so expansion choices made before the change still apply.
- `tool-groups.ts` now exports `groupConsecutiveActivity` (replacing `groupConsecutiveTools`); `session-view.ts` renders `renderActivityGroup`. Presentation only: event folding, tool/result correlation, and the journal are unchanged.
- Validation performed: `npm run check` passed (type checks, build, all 137 tests, desktop bundle) along with `git diff --check`. Three rewritten grouping tests cover thinking inside groups, standalone thinking-only runs and lone calls, and stable start indices while thinking and results stream. Not performed: an Electron visual check.

## 2026-10-14 - Timeline phase 1: per-session capture and checkpoint list

- Added the first optional feature module, `src/features/timeline/`, implementing phase 1 of the Timeline product specification. A session opts in with **Import timeline**, which imports eligible checkpoints from its exact refs (`refs/rack-timeline/<session ID>`, plus `refs/codex-timeline/<native ID>` for imported Codex sessions) and enables recording. During runs, Rack captures observed repository states at run start, tool request/result boundaries, debounced filesystem activity, and run settlement. Capture uses a temporary Git index and hidden refs, so HEAD, branch, index, and working files are unchanged. Identical trees create nothing, and display filtering applies exclusions plus current ignore rules at query time.
- The Timeline plugin surface is no longer a placeholder. It shows the specification's states and a newest-first checkpoint list with "N files changed", labels, times, folder/file trees, and 16-row diff previews. It also offers filtering by number, label, or path, and Disable, which keeps history.
- Contracts: `timeline.status`, `timeline.setEnabled`, `timeline.checkpoints`, and `timeline.fileDiff` commands; the `timeline.changed` event; and the `feature_unavailable`, `timeline_busy`, `timeline_unsupported`, `snapshot_not_found`, and `snapshot_path_invalid` error codes. Timeline owns `timeline.json` (schema 1). No core schema changed.
- Architecture: core modules do not depend on Timeline. Composition assembles it (default on) behind a narrow `TimelineCoreAccess` port. The host captures the run-start state before `execution.start` and feeds run events to a guarded observer in `ActiveRuns`. Timeline failures never block or fail a run.
- Deliberate deviations, documented in [Timeline](timeline.md): baselines are structural (no predecessor) rather than label-based, capture failures are reported and retried on the next run instead of latched, and the list is newest first.
- Not implemented (later phases or missing prerequisites): project history, the historical snapshot viewer and line origins, content search, review notes and AI review, editor-save checkpoints, account-switch checkpoints, and host-owned plugin toggles.
- Validation performed: `npm run check` passed (Node/renderer type checks, headless build, all 136 tests, desktop bundle), and `git diff --check` reported no whitespace errors. The 20 new tests use real Git repositories in temporary folders. They cover acceptance criteria T01, T03 to T10, T13, and T14. They also cover visibility filtering, exact-ref and Codex-ref import, external baseline filtering, specified error messages, watcher debounce and coalescing, host command dispatch, run capture through `ActiveRuns`, `timeline_busy` during runs, and `feature_unavailable` without the feature. Not performed: an Electron UI check of the Timeline surface, authenticated provider runs, a packaged build, or measurement on large repositories.

## 2026-10-14 - Git Source Control layout for Changes

- Rebuilt the right Changes surface around compact staged/working-tree/conflict file lists, counts, Git status letters, repository/branch labels, and one selected file's numbered diff. Added inline/split comparison, safe file opening, and close-diff controls. Discovery actions moved into a small options menu. Selection and diff scroll positions survive polling; project/repository switches invalidate stale views.
- Added normalized status records and per-file comparisons to the Projects read contract. The Git adapter parses NUL-delimited porcelain, preserves both sides of partially staged edits and staged changes reverted in the working tree, scopes tracked filenames to the chosen folder, and supplies ordinary conflict patches against ours. File rows remain visible when text/binary/large previews are unavailable. Legacy combined diffs remain available, and Git index bytes stay unchanged by reads.
- Validation performed: Node/renderer type checks, headless build, all 116 tests, desktop build, and whitespace checks passed. New/extended tests cover status groups, scoped/newline filenames, renames/deletions, staged-versus-working comparisons, reverted staged edits, merge conflicts, index preservation, line numbering, and split alignment. Electron checks used the real host and Git reader against temporary repositories and confirmed status letters, separate staged/working previews, numbered lines, two visible split panes, live refresh retaining selection, binary notices, switching projects, all-repository discovery/selection, and unchanged index bytes; screenshots reviewed. Type checks and desktop build were repeated after split-pane adjustments. Not performed: a packaged build, destructive Git actions, or live provider runs.

## 2026-10-14 - Minimal model dropdown and borderless tool groups

- Removed the box and divider around compacted tool-call groups; the count/status row and expandable nested calls remain.
- Replaced the model modal with a small dropdown anchored above the composer. Removed search, visible descriptions, modal heading/backdrop, and the selected-model card. Model names lead to the same reasoning slider and small Fast tag; a back arrow returns to the list and a checkmark closes the dropdown. The shared popover can reposition after content changes so the smaller settings panel stays beside its trigger.
- Validation performed: Node/renderer type checks, desktop build, and whitespace checks passed. An isolated Electron stub-host check confirmed no search or modal backdrop, a 250 px dropdown, borderless groups, list-to-slider re-anchoring, keyboard effort selection, Fast toggling, and Escape dismissing the picker without cancelling the run. Screenshots reviewed. The existing headless test suite was not rerun for this presentation change; no authenticated provider run or packaged build was performed.

## 2026-10-14 - Group tool calls, unify model settings, Escape to stop

- Consecutive tool calls and orphan tool outputs render as one collapsible group with a count and aggregate status. Text/thinking/status messages separate groups; individual calls retain their own details. Stable group keys preserve expansion while streaming. Live, persisted, and imported history share the presentation.
- Replaced the separate model/effort/speed pills with one model-settings modal. Its searchable, provider-grouped model list transforms into the selected model's reasoning slider and compact Fast switch. Change returns to the list; Done closes the modal. Effort/Fast preferences are revalidated against the model; unsupported controls are absent or disabled. Adapters mark speed entries with optional `fast` semantics so the UI sends the correct provider IDs without provider-specific logic.
- Escape uses Stop's cancellation operation for the current session, preserves drafts, and ignores repeated/cancel-pending requests. Menus, model/import modals, and Settings consume Escape before run cancellation; other sessions keep running.
- Validation performed: type checks, headless build, all 111 tests, desktop bundle, and whitespace checks passed. Added tests cover grouping boundaries/stable indices, result preservation, reasoning defaults and stale levels, speed preference migration, and explicit standard/fast mappings. An isolated Electron stub-host check verified grouped/nested disclosure persistence during streaming, collapsed-body hiding, model search and list-to-slider transition, keyboard slider changes, Fast on/off, unsupported models, cross-provider fallback, submitted settings, modal/menu/Settings Escape precedence, cancellation of only the selected session, draft preservation, and no duplicate cancellation after completion. Screenshots reviewed. Not performed: authenticated provider model runs or a packaged build.

## 2026-10-14 - Session file attachments

- Added the composer clipboard icon and an upward-opening menu for Images, Documents, Code and text, and Any file. The native picker supports multiple files; removable filename/size chips stay with each session's draft. Attachment-only messages are supported, imports block sending, failed starts retain files, and sent attachments remain visible and clickable after reload.
- Added session-owned file storage behind the Sessions attachment port, assembled at startup. Copies and manifests live outside projects; execution resolves attachment IDs in the destination session before recording a run, saves descriptors on the run, and supplies quoted file paths through the existing runtime prompt and saved conversation. Limits are 20 files per message and 50 MB per file. Any format can be attached; content interpretation uses runtime tools and local readers. Removed draft copies remain retained; automatic cleanup is deferred.
- Validation performed: type checks, headless build, all 105 tests, desktop bundle, and whitespace checks passed. New tests cover byte-preserving storage/reload, original removal, manifest-name collisions, empty files, invalid paths/IDs, oversized files, cross-session ownership, failed-batch rollback, contract limits, attachment-only execution, native start/resume file references, and rejection before creating runs. An isolated Electron fixture using the real host and storage plus a fake runtime verified upward placement, keyboard navigation/Escape, multi-format selection, chip removal, failed-start preservation, attachment-only sending, runtime access to saved copies, renderer reload persistence, session switching during selection, cancellation, and count-limit errors; screenshots reviewed. Type checks were repeated after the session-loading guard. Not performed: authenticated Codex/Claude attachment reads, native OS picker interaction, document conversion, or a packaged build.

## 2026-10-14 - Scope native continuations to the account runtime context

- Fixed "no rollout found for thread id" after switching a session to another Codex account (manually or through automatic fallback). Session continuations were keyed only by runtime, so the second account tried to resume a native thread that exists only in the first account's isolated `CODEX_HOME`. The same mismatch applied to Claude's per-account configuration directory.
- Continuations now record the account's `runtimeContextId`, and lookups match runtime and context. Switching to a new account starts a fresh native thread; switching back resumes that account's own thread. Continuations saved before this change have no context and are ignored, so an existing session starts one fresh native thread on its next run (the app transcript is unaffected).
- Known gap, not addressed here: a fresh native thread after an account or provider switch does not receive the earlier conversation as context; only imported sessions do.
- Validation performed: `npm run check` (100 tests, including a new account-switch regression test). Not performed: a manual run against two real Codex accounts.

## 2026-10-14 - Speed options, clickable links and paths, app-drawn controls, Changes selection race

- Speed: `RuntimeModel.speeds`/`defaultSpeed` and `speed` on `runs.start`, runs, and adapter input. Codex maps service tiers (plus standard `"default"`) and sends `serviceTierForTurn`; Claude offers Standard/Fast for fast-mode models via the SDK `fastMode` setting and rejects unknown values. A speed pill joins the effort pill; both use the new `components/model-option-picker.ts`. Run details shows speed.
- Links and paths: bare http(s) URLs and conservative path detection in Markdown (text and whole inline-code paths); clickable file targets on activity cards, approvals, and Changes files. New `openPath` bridge call; main resolves paths and reveals rather than opens anything that could execute. `http://` links now open too.
- No native choice controls: Changes repository and Run details pickers use app dropdowns; session import uses the new app checkbox.
- Changes panel: fixed a race where a poll paired the live selection with the previous project's repository list (seen as "Repository unavailable" or a stale panel after switching projects while the window was hidden); the panel also refreshes when the window becomes visible.
- Validation performed: type checks, all 99 tests (new: Codex/Claude speed catalogs and pass-through, path classification, URL/path parsing), and desktop bundle passed. Real-app checks against scratch Git repos and a copy of local project/session lists (no credentials) confirmed project switching and diffs for all three local projects, the app repository dropdown, clickable diff file names, and `openPath` missing/invalid outcomes through main. Stub-host screenshots confirmed the speed pill and menu; a rendering check confirmed link/path styling and click routing. Not performed: opening real files (to avoid launching apps), a live provider run with a chosen speed, and a packaged build. The original "git tree is not working" report could not be reproduced in a visible window; the fixed race is the only failure found.

## 2026-10-14 - Reasoning effort, scrolling dropdowns, background approval badges

- Added reasoning effort end to end: `RuntimeModel.reasoningEfforts`/`defaultReasoningEffort` in catalogs, `reasoningEffort` on `runs.start`, `RunRecord`, and `RuntimeRunInput`. Codex reads `supportedReasoningEfforts`/`defaultReasoningEffort` from `model/list` and sends `effort` on `turn/start`. Claude reads `supportedEffortLevels` and sets the SDK `effort` option, rejecting unknown levels visibly. The composer shows an effort pill limited to the selected model's reported levels; Run details shows the run's effort.
- Popovers are height-capped at 320 px and scroll, with sticky provider group headings, so the model list is a short scrolling box.
- Sessions waiting for an approval show a pulsing hand icon and "Needs approval" in the sidebar (and on collapsed projects), including sessions other than the open one.
- Validation performed: type checks, all 93 tests (new tests for Codex and Claude effort catalogs and pass-through, unsupported Claude levels, and execution recording), and the desktop bundle passed. Codex 0.162.1's generated app-server schema and the installed Claude Agent SDK types were checked for the effort fields. An Electron run of the built renderer against a stub host confirmed the background session badge, the effort pill defaulting to the model default, the 320 px scrolling model list, the effort menu, and the focused approval card (screenshots reviewed). Not performed: a live provider run with a chosen effort, and a packaged build.

## 2026-10-14 - Resizable panels, minimal scrollbars, focused approvals, tables

- Both side panels are resizable by dragging their inner edge (`components/resize-handle.ts`), with keyboard arrows and double-click reset. Widths persist per device (`layout.widths`), keep the main column at least 420 px, and re-fit when the window shrinks or a panel is toggled.
- Scrollbars are minimal app-wide: trackless 4 px thumbs that appear only while hovering the scrolling region.
- Approval overlays show only what is being approved (action, target, diff or arguments, reason), described through the same `presentTool` mapping as activity cards. Account, model, run/attempt, and request ID were removed from the overlay; `ui-spec.md` updated accordingly.
- Thinking traces drop the "Thinking trace"/"Reasoning summary" label and caret; a lightbulb beside the text collapses it to one line. Vertical margins and left padding are halved. The summary/trace distinction moved to the button's accessible name and tooltip.
- Markdown supports GitHub-style pipe tables: alignment, escaped pipes, inline formatting in cells, ragged rows, and horizontal scrolling for wide tables. Incomplete tables stay paragraphs while streaming.
- Validation performed: type checks, all 90 tests (3 new table parser tests), and the desktop bundle passed. An Electron 44 run of the built renderer against a stub host confirmed a pointer drag resizes the sidebar to 360 px with saved width and ARIA value, and screenshots confirmed table rendering in light and dark themes. Not performed: visual checks of the approval overlay and thinking panel with live provider events, scrollbar hover appearance, and a packaged build.

## 2026-10-14 - Native automatic permissions and active-run progress

- Replaced Approve for me’s Ask me placeholder with provider-owned review: Codex workspace-write/on-request with `approvalsReviewer: "auto_review"`, and Claude SDK `permissionMode: "auto"` without the Rack interactive approval callback. Apply explicit settings to new/resumed threads and Codex turn starts. Provider denials remain denials; unexpected Codex manual prompts fail visibly instead of silently asking or granting access.
- Preserve approved Claude tool input in native responses and explicitly deny mutation callbacks in planning/read-only mode. Updated permission disclosures and documentation.
- Keep the permission picker bound to the actual active run mode and disabled until it ends, preventing misleading mid-run changes.
- Hide response timestamp footers during queued/running work and show animated three dots until terminal status. Keep animation phase through streaming redraws and honor reduced motion.
- Validation performed: type checks, all 83 tests, desktop bundle and whitespace checks passed. Tests cover all native permission mappings, resumed runs, read-only denial, approved input preservation, and prevention of interactive fallback from auto review. The installed Codex 0.162.1 generated schema and an isolated ephemeral thread-start smoke check confirmed native `auto_review` support without starting a model turn. Browser fixture checks confirmed three dots and no timestamp before/during streaming, disabled permission picker while active, and timestamp/picker restoration after completion. No authenticated provider model run or packaged Electron check performed.

## 2026-10-14 - Quiet response footers, streaming, and side diffs

- Reduced response footers to date/time. Moved account/model/permission, status, recovery and journal diagnostics into a right-panel Run details surface with a run picker; Stop remains in the composer.
- Preserved Claude readable content from initial streamed blocks and deduplicated final messages. Added checks that thinking and responses reach the live view before completion.
- Replaced the Changes placeholder with a read-only project Git diff: staged/unstaged changes against HEAD plus bounded new text files, with binary/large-file notices, per-file dropdowns and highlighted additions/deletions. Poll while visible, serialize reads and discard replies for a different selected project. This is current project state, including pre-existing edits, rather than per-run attribution.
- Validation performed: type checks, all 80 tests, desktop bundle and diff whitespace checks passed. Git fixtures covered index preservation, staged/unstaged edits, new/binary files, unborn repositories, subfolder scope and non-Git folders. Browser fixture checks confirmed streaming before completion, timestamp-only footers, highlighted side diffs, collapsed tool bodies, and Allow without cancellation; reviewed a screenshot. No live provider execution or packaged Electron check performed.

## 2026-10-14 - Rearrange sidebar folders and sessions

- Added sibling-scoped drag/drop ordering and Alt+Up/Down keyboard moves with local preference persistence, drop indicators, stale-ID cleanup, and newly added row handling. Project identity and session associations remain owned by the host.
- Reduced folder-row and tool-dropdown vertical padding.
- Validation: type checks, all 75 tests (including saved-order reconciliation and sibling moves), desktop bundling, and diff whitespace checks passed. Tests/build required an elevated rerun because the sandbox blocked the tsx IPC socket. No visual drag/drop interaction test performed.

## 2026-10-14 - Collapse command activity into status dropdowns

- Show tool activity as compact, initially collapsed rows with live status and a command/target preview. Reveal detailed commands, output and diffs only when expanded; preserve the existing expansion memory during streaming.
- Explicitly hide closed activity bodies and reserve the boxed panel appearance for expanded rows.
- Validation performed: type checks, all 73 existing tests, and desktop bundling passed. Visual browser validation and live provider execution were not performed.

## 2026-10-14 - Keep approval responses from stopping execution

- Set Allow and Deny to ordinary buttons inside the composer form. Previously, answering an approval also submitted the form and triggered cancellation of the active run.
- Validation performed: type checks, all 73 existing tests, and the desktop bundle passed. Live provider execution and browser click validation were not performed.

## 2026-10-14 - Batch session import and readable runtime activity

- Added import checkboxes, Select all for not-yet-imported sessions, selection counts, independent previews, and batch import with preserved successes and retryable failed selections.
- Simplified the composer permission menu to Ask me, Approve for me, Full access, and Read only, without descriptions. Runtime enforcement and diagnostic mappings are unchanged.
- Display provider-exposed thinking as open prose, with summaries labelled separately. Retain thinking/tool activity at run completion and reconstruct saved activity from journals. Enable Claude partial messages and avoid duplicating final streamed content.
- Added formatted tool cards for commands, file targets, diffs and output, with outcomes, exit codes and durations. Correlate parallel tools by call ID; streamed output does not imply completion. Retain readable thinking and paired Claude tools during import.
- Validation performed: type checks, 73 tests including Select all, partial batch failure, journal restoration, streaming trace deduplication, tool identity/output correlation and formatting, headless build, desktop bundle, Markdown links/fences, and diff checks. No live provider execution or visual browser validation was performed; computer use reported no available browser in this session.

## 2026-10-14 - Import local provider sessions into projects

- Added project-scoped Codex app-server and Claude SDK history sources, partial discovery failures, and preview/import host commands. Imported native IDs are provenance, not assumed resume handles. Concurrent/repeated imports reuse a session; source folder and identity are checked before saving a complete snapshot.
- Added the project-row import action, preview dialog, imported conversation/tool history, and fresh-context continuation. The first run receives recent visible conversation as background while preserving the real user prompt, selected permissions/account, and external session.
- Updated architecture, MVP, desktop, and UI documentation and added `session-import.md`.
- Validation performed: type checks, 62 tests covering parsing/pagination/timeouts, folder scope, idempotency, partial failure, durable host import/reload, and continuation; headless build, desktop bundle, and Markdown/diff checks. Inspected installed Codex-generated schemas and Claude SDK types. A local Claude helper check returned no matching sessions in the tested folder. Codex initialization against its original store exited in this sandbox; copied stores returned no discoverable sessions, so native live-history import remains unverified.
- Not performed: live model execution, imports into the user's real Rack data, or visual UI verification. The browser CLI could not write its socket directory, and computer use reported no available browser. No screenshot-based validation is claimed.

## 2026-10-14 - Consolidate duplicate folder projects

- Found two saved project IDs pointing at the same folder. Upgraded projects to schema 4 with one canonical project per normalized path and persistent aliases for former duplicate IDs. Sessions and execution upgrade to schema 3 and resolve those aliases before returning saved history to the UI. Conflicting active writers stop migration rather than silently losing ownership.
- Repeated or concurrent folder additions reuse the existing project. Serialized project creation and writer mutations prevent competing requests from creating another identity or acquiring two writer locks.
- Validation performed: 53 tests, type checks, headless build, desktop bundle, local Markdown links/fences, and `git diff --check`. Verified through the host API against a temporary copy of the user's saved metadata: 2 projects became 1 while preserving all 3 sessions, 6 runs, 93 journal entries, attempts, outcomes, and native continuations. The original app data was not edited directly.
- Not performed: visual validation or restarting the live Electron app. The running host caches its loaded data; a full app restart with the rebuilt bundle applies the upgrade.

## 2026-10-14 - Use one project identity for the selected folder

- Replaced workspace-named services, records, host commands/events, session/run references, model discovery inputs, and renderer state with the single project concept. The sidebar, folder picker, transcript, and error messages now consistently say Project. Removed shared/isolated kind from the project model; future isolated execution directories remain associated with a project.
- Added automatic upgrades to projects schema 3 and sessions/execution schema 2. Preserved saved folder IDs, session messages, native continuations, attempts, journal entries, run outcomes, revisions, and writer ownership. Imported all folders from older project/workspace documents before new saves, including partial imports. Retained the legacy workspace file and sidebar expansion preferences.
- Reject a run whose project differs from its session before recording work or calling a runtime. Updated the architecture, MVP, desktop, and UI documentation to match the new contracts.
- Validation performed: Node and renderer type checks, headless TypeScript build, 48 tests (including migration/reload, partial import, corrupt legacy data, canonical host identity, and mismatched-project rejection), desktop bundle, local Markdown links/fences, and `git diff --check`. Used `node --import tsx` for the test runner and desktop build because the tsx CLI's IPC socket is restricted in this session.
- Not performed: live provider execution or visual Electron validation. The earlier Electron launches in this session aborted during macOS application initialization.

## 2026-10-13 - Unify workspace navigation and remove setup text fields

- Replaced the separate project tree and workspace list with one workspace folder tree. Sessions nest beneath their workspace, and the workspace plus button creates a session immediately with a generated title.
- Workspace creation now uses only the native folder picker. The selected folder supplies the project name and shared workspace path, so project, workspace, path, starting-revision, and session-title input boxes are absent from the setup flow.
- Loaded workspaces across all projects for the unified navigator and improved sidebar row/button padding for clearer click targets.
- Validation performed: `npm run check` (41 tests), plus `git diff --check`. The local Electron app was launched from `dev` and the unified workspace tree rendered without setup input fields.

## 2026-10-13 - Restore the chat transcript after the model picker merge

- The merge of the model picker branch (`0b131ec`) resolved the renderer conflicts in favor of that branch, which predated the chat transcript, so the session view and its styles fell back to run cards. Reapplied the chat transcript (prompt bubbles, Markdown replies, meta row, tool rows, turn navigator, "Scroll to end") on top of the merged state.
- Kept the model picker branch's behavior: thinking traces render as a collapsed "Thinking" row in the tool-row style, pending approvals stay in the composer overlay instead of the transcript, user-message metadata stays hidden, and the reply meta row no longer shows the runtime because the selected model determines it. Composer, model catalog, host, and adapter code were not changed.
- Validation performed: `npm run check` passes (41 tests). In the running app with throwaway test data, a session rendered three chat turns (prompt bubbles, the clipped long prompt, Markdown replies, meta rows) and no run cards.
- Not performed: streaming, thinking rows, tool rows, and the approval overlay during a live run.

## 2026-10-13 - Unified model selection and composer approval overlay

- Added provider-backed model discovery to the host `models.list` catalog and runtime adapter model contracts. Codex reads the paginated app-server `model/list` catalog and Claude reads Agent SDK `supportedModels()` in an idle, non-persisted query. The host queries every connected account, deduplicates entries, keeps account provenance, reports partial failures, and refreshes after account/workspace changes.
- The composer now presents a list-only Claude/Codex model catalog, routes the selected model to its owning provider/runtime internally, filters account choices to that provider, and explains empty or partial discovery results. There is no runtime picker or free-form model editor.
- Removed expandable user-message metadata from the transcript, added normalized thinking traces, and kept tool calls visible.
- Moved pending approval cards out of the transcript into an overlay above the prompt composer. Approvals remain brokered by the host and survive renderer reconnects.
- Validation performed: `npm run typecheck`, `npm test` (38 tests), and `npm run build:desktop` pass. Live provider execution and a real approval response were not run.

## 2026-10-12 - Simple chat transcript

- Replaced run cards with a Codex/T3-style chat. Prompts are right-aligned bubbles with clipping for long text. Replies are Markdown-rendered page text with a meta row (copy, time, labels, Details, Stop), compact expandable tool rows, inline approval cards, a turn navigator, and a "Scroll to end" pill. Run details moved behind the per-reply Details toggle.
- Added `markdown.ts`, a pure parser with a DOM renderer that uses text nodes only, and tests for blocks, streaming fences, inline markup, and rejection of non-http links.
- Validation performed: `npm run check` passes (37 tests). In the running app, a session with completed turns in the throwaway test data rendered prompt bubbles, the clipped long prompt, inline code, bold, a numbered list, a code block, and meta rows.
- Not performed: streaming, tool rows, and approvals during a live run.

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
- Rebuilt the composer as one card: an auto-growing prompt and a toolbar of pill menus (permission, account, model) plus a round send button that becomes a stop button while the session has an active run. Capabilities and native permission mappings moved into the menu option descriptions. Enter now sends.
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
