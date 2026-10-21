# Timeline

Status: session capture and existing project history implemented 2026-10-14; standalone snapshot viewer added 2026-10-15. Later features listed under [Not implemented](#not-implemented) are proposals, not available behavior.

Timeline gives a developer a local history of observed repository states during runs. It follows the product specification derived from Relay (`TIMELINE_PRODUCT_SPEC.md` in the sibling Relay repository), adapted to Rack's architecture. The core promise is **inspectable observed states**. It is not a complete record of every edit, and it does not prove which tool or person caused a change.

## Using it

**Single Timeline view (2026-10-21).** The panel no longer has a **This session** tab. Its two views are **Current branch** (formerly **Project history**: HEAD's first-parent history) and **All branches**. Session checkpoints that were already recorded still appear in both views, because project history reads every `refs/rack-timeline/` ref. Git operations such as staging, committing, pushing and merging live in the [Changes panel](changes-view.md); Timeline keeps its branch checkout picker. The host still serves the session commands (`timeline.status`, `timeline.setEnabled`, `timeline.checkpoints`, `timeline.fileDiff`) and keeps recording sessions that were enabled earlier, but the panel no longer offers a way to enable or disable session recording. Removing that host capability, or giving it a new home, is a separate decision.

**Interface (2026-10-20).** Sidebar history rows show the title, file count (for example, **2 files**) and relative time on one compact line. Decorative kind icons, the Observed edit/Commit/Agent run labels and the separate branch-label line are removed. Full titles, provenance, branch tips and merge-parent information remain in row tooltips. Disclosure arrows and expanded-snapshot controls stay available. Import timeline and Choose a repository folder are icon-plus-label buttons. The expanded snapshot window has a title with the commit chip and a readable date, and one newer · change · older toolbar with the position under it. **Diff**, **Before / After** and **Full context** form an icon toggle with names in tooltips. File scope tabs show counts as badges. Pull request comparisons open in the same window via **Open in Timeline** on a PR review.

The sidebar surface and expanded snapshot viewer use Inter for headings, file names, filters, and controls. Sidebar lists match Changes: 13 px text and 31 px rows, with single-line checkpoint summaries and truncated long labels available in tooltips. Repository choices and nested file/folder rows use the same compact sizing. The panel heading is 16 px; code uses bundled Geist Mono at 14 px. Stronger green/red backgrounds, colored edge markers, and heavier line numbers distinguish additions/deletions in diffs; Before / After retains its added-line highlights using the stronger green. Scope tabs wrap at narrow widths.

1. Saved Git projects record automatically while Rack is open, including projects with no sessions or existing Timeline refs. Enable the Timeline surface in **Settings > Plugins** to inspect them (shortcut `L`). The surface toggle only shows or hides the panel.
2. Open a project and the Timeline surface. **Current branch** opens by default and immediately shows existing Git commits, project observations and saved session snapshots. No selected session or recording opt-in is required. **All branches** adds unmerged branch and remote-tracking work.
3. **Pause / Resume** controls automatic observations for that project and keeps its history.
4. Run the agent. Changes with visible file changes appear newest first. Each shows its title, file count and relative time, a folder/file tree, and a 16-row diff preview of the selected file (first file by default), expandable to the full bounded patch.

(Session opt-in through **This session → Import timeline** was removed from the panel on 2026-10-21; see the note above.)

The Timeline panel owns vertical scrolling within the workbench, including its controls, notices and history. Long lists remain reachable at the minimum window size; polling and manual refresh preserve the panel scroll position.

### Existing projects and sessions

**Project history** reads the current HEAD's first-parent commit history and every ref under `refs/rack-timeline/`, `refs/rack-project-timeline/`, `refs/codex-timeline/`, and `refs/relay-timeline/` in this repository. It distinguishes Git commits, run checkpoints and project observations, with original session provenance when recorded. Root Git commits show their added files; snapshot baselines are hidden. A commit reachable from multiple refs appears once. Reading history never creates snapshots, changes a recording preference, or assigns another session's work to the selected session.

The view reads the 200 most recent reachable commits/snapshots and shows a notice when bounded; entries with no currently visible changed files are omitted. The filter searches labels, numbers, and paths. Dates appear beside entries and complete timestamps in tooltips. File trees and previews work for existing history just as they do for new recordings. Refresh is available, external changes poll every four seconds while visible, and app timeline events refresh it immediately. Immutable file comparisons are cached in a bounded host cache; current ignore rules are re-read on every query.

Projects opened at a subdirectory still use their Git repository root. A container project such as `rack-desktop` with a single repository in `rack-code` resolves that repository for history, session capture, and automatic project recording; the watcher watches the resolved root. Detection reuses Changes' bounded discovery (three levels, common dependency/build folders skipped, no directory symlinks followed, results cached for up to a minute). Multiple repositories or an incomplete scan expose **Choose a repository** with clickable discovered paths and **Scan deeper**. Choosing a folder reuses or adds its normal project record and opens its Timeline inside the panel, preserving the selected chat, messages and composer draft. A repository label and **Back to project** action identify this local view. It resets when the chat changes projects; container sessions retain their original project. Limited scans, failures, and empty results stay visible, and stale discovery responses cannot replace another project's chooser. Folders without a repository remain unsupported. Old sessions need actual saved timeline refs to expose intermediate edits; conversation history alone cannot reconstruct snapshots. Their committed work remains available through Git history.

Clicking a project folder in the navigator selects it even if it has no sessions. Expanding or collapsing the already-selected project keeps its current session open.

### All branches and branch checkout (2026-10-20)

**All branches** is the repository-wide Timeline. It includes all locally known local and remote-tracking branches, detached HEAD when present, and supported saved Timeline refs. It walks every merge parent, deduplicates commits and keeps topological order, so unmerged work and merged topic commits remain visible. Branch names label tips, not every ancestor. Merge rows retain parent IDs and first-parent comparison information in their tooltip. Empty commits and merges remain visible even when they have no visible changed files. Existing path exclusions still apply. Search also matches branch-tip labels. This is one repository's history, not a combined feed of unrelated projects.

Both project views show a **Checkout project branch** picker with local/remote groups and worktree occupancy. Selecting a candidate opens a confirmation showing the actual checkout folder. Local branches switch in place; remote-tracking branches create a local tracking branch when the local name is free. The picker does not fetch. Branch checkout targets the displayed project checkout and leaves isolated session worktrees on their own branches.

Checkout refuses uncommitted tracked/untracked files, stale HEAD, invalid/deleted refs, a branch occupied by another worktree, and active app-managed runs in the same repository (including project aliases). Git's own checkout checks remain authoritative if external processes race the request. Rack never force-switches, stashes, resets, discards edits or bypasses a worktree conflict. Checkout hooks are disabled. A brief host-owned checkout barrier prevents new run writer ownership while switching. Errors leave a visible explanation; retry after resolving the cause.

The history remains bounded to the latest 200 commits/snapshots, with a truncation notice. Remote branches reflect the last fetch performed through your Git tools. Global entries use the same immutable previews and expanded snapshot viewer; the viewer's change selector includes branch history. Recording and snapshot reads remain independent of explicit checkout actions.

### Automatic project recording

The desktop execution host starts project observers at startup, and discovers newly added or newly initialized repositories at most five seconds later. File notifications are debounced for 500 ms and serialized. One observer per repository root prevents duplicate chains for subfolder aliases; the first eligible saved project owns the chain. If recursive watching is unavailable or ends, five-second observations provide a fallback. Removing a project or quitting closes its observer.

A project with no Timeline chain compares its first observed working state to HEAD when a commit exists, so current uncommitted changes are included immediately. A repository with no commits first establishes a baseline, then records later edits. This recovers the current state; intermediate edits that were never captured cannot be recreated. Observations use `refs/rack-project-timeline/<project ID>` and a `Rack-Timeline-Project` trailer. Their parent is the preceding observation, or initial HEAD. HEAD, the user's index and working files are unchanged.

Explicit project pauses are persisted in the additive `projects` field of Timeline's schema-1 document. Old documents without this field default to automatic project recording. Session opt-in stays separate: disabling one session stops its run chain, while the project observer continues unless paused. Headless readers do not start project observers; the desktop host explicitly owns startup and shutdown. Capture failures appear in the panel and retry on a subsequent observation.

### Expanded snapshot window

Choose **Open snapshot** (the expand icon) on any history entry to open a separate native desktop window. The expand icon beside an inline preview opens the same snapshot with that file selected. Each window keeps its own snapshot and selection when the main chat changes projects or sessions.

The prominent bordered **Change** dropdown navigates other Git commits and saved changes in the same project, including other sessions when opened from This session. Options include their time and short identity. Up/down buttons step to newer/older changes without opening the dropdown; a position counter shows the current entry in newest-first order, and buttons disable at either end. The list refreshes while visible without moving the current selection. The initial session checkpoint and a currently selected known target are retained if older than the recent project page. Switching changes preserves the view mode and selected file when available; stale loads cannot overwrite the newer selection, including during rapid stepping.

- **Changed files** lists changed paths; **All files** includes unchanged paths and retains deleted files from the before tree so they can still be inspected. The folder tree supports collapsing and a filename/path filter. Existing visibility exclusions and current ignore rules apply to both lists.
- The **View mode** dropdown offers **Diff**, **Before / After** and **Full context**. Diff shows the bounded patch. Full context includes unchanged lines before, between and after hunks and starts near the edit. For an unchanged file, Diff and Full context both show its full contents.
- **Before / After** shows both exact, numbered historical versions side by side, with Before on the left and After on the right. Added and replacement lines in After are highlighted using Git's new-side line numbers; unchanged lines stay plain. Each pane scrolls independently and keeps its heading visible. Missing, empty, binary or oversized versions show their own notice without hiding the other side. Root commits have no before tree. Exact contents remain available for shortened patches, with a notice that highlighting is unavailable instead of guessing omitted edits.
- All contents come from Git objects, including final newlines and empty files. The working files are never opened, checked out, restored or edited. Symbolic links are not followed; submodules and binary files show notices.
- Contents larger than 1 MiB are not loaded, and code views render up to 10,000 lines with a visible limit notice. Diff previews retain their 400,000-character bound. If the diff is shortened, Context shows available source with a warning rather than guessing which omitted lines changed.
- Escape or **Close window** closes just the viewer. Recording and active runs continue in the main window.

## User-facing states

| State | Presentation |
| --- | --- |
| No project selected | "Open a project to view its timeline." |
| History loading | "Loading project history…" |
| Unsupported (missing folder, non-Git folder, Git unavailable) | The reason, plus **Choose a repository** when discovery finds candidates |
| Supported, no entries | Filter and Pause/Resume controls, and "No existing commits or recorded file changes in this project yet." |
| Supported with entries | Filter, Pause/Resume, branch picker and the history list |
| Bounded history | "Showing history from the 200 most recent commits and saved snapshots." |
| Last capture failed | Warning with the Git error; Rack retries on the next observation |

The filter is a case-insensitive substring match over the checkpoint number, label, and changed paths. It does not search file contents. With no matches the list shows "No matching recorded changes."

## Recording

| Trigger | Label |
| --- | --- |
| Run start, first snapshot of the session chain | `Session baseline` |
| Run start, chain already exists | `Run started` |
| Normalized `tool_request` | `Before tool` (with tool call ID) |
| Normalized `tool_result` | `After <tool name>` (with tool call ID) |
| Filesystem activity during a run, 120 ms debounce | `Live filesystem observation` |
| Run finalization, including failure and cancellation | `Run settled` |

The run-start capture completes before the run starts, so it precedes any runtime edit. For opted-in sessions, starting a run therefore waits for one capture: a few Git processes, longer in large repositories, with a 30-second per-command timeout after which the run proceeds without Timeline. The watcher exists only while a run is active. If recursive watching is unavailable, tool and run boundaries still apply. Bursts of filesystem activity coalesce into one observation, and files created and removed between captures may never appear.

Tool notifications are asynchronous. An edit may already be on disk when `Before tool` is captured, so labels describe when Rack looked, not who changed what. Capture is repository-wide, so a checkpoint can include changes made outside the agent or elsewhere in the repository.

### Snapshot semantics

- Capture stages the repository's eligible files into a private temporary Git index, seeded from cached stat data when available, writes a tree and commit object, and advances `refs/rack-timeline/<session ID>` with compare-and-swap. The user's HEAD, branch, index, and working files are never changed. Git objects and the hidden ref are written into the existing repository.
- Each snapshot's parent is the previous snapshot of the session chain. An identical tree creates nothing.
- Snapshots cover the Git repository root, even when the project folder is a subdirectory.
- Git ignore rules decide what enters a snapshot, even for paths the user's own index tracks, because cached entries that now match ignore rules are removed before staging. Timeline is not a secrets filter.
- Commits use the author `Rack timeline <timeline@rack.local>` and the subject `timeline: <label>`, and carry `Rack-Timeline-Session`, `Rack-Timeline-Run`, and `Rack-Timeline-Tool-Call` trailers. Commit signing, fsmonitor, external diff drivers, and text conversion are disabled for these commands, and inherited `GIT_DIR`/`GIT_INDEX_FILE`-style variables are removed.
- Operations on one session's chain are serialized in the execution host. This is not a lock across unrelated processes.

### Visibility filtering

Displayed changed paths exclude any path component named `.git`, `.github`, `node_modules`, or `.runtime`. Current Git ignore rules (nested rules, negations, global excludes) are then applied with `git check-ignore --no-index`, using the rules at query time. The checkpoint index stores the unfiltered changed paths, so later rule changes take effect without re-recording.

## Import

**Import timeline** reads only exact identities:

- `refs/rack-timeline/<Rack session ID>`;
- for sessions imported from local Codex history, `refs/codex-timeline/<native Codex session ID>`.

Similarly prefixed refs, other sessions, and ordinary commits are never fallback sources. Import reads a bounded first-parent history of up to 2,001 records. An eligible record is a recognized timeline commit (Rack's author and trailers, or an external commit whose subject starts with `timeline:`/`codex-timeline:` or whose author is `Relay timeline`). It must have a parent, must not be an external baseline label, and must have at least one visible change. Imported checkpoints are inserted by time and de-duplicated by snapshot hash.

Rack never writes to `refs/relay-timeline/` or `refs/codex-timeline/`.

## Failures

- Timeline never prevents a run. `beginRun` and the run observer swallow every Timeline error.
- The first failed capture stops capture for the rest of that run. The message is remembered for the repository during the current application lifetime and shown as a warning. The persisted opt-in is not cleared, and the next run tries again.
- Unknown checkpoints fail with "No snapshot for this action" (`snapshot_not_found`). Paths that are not visible changed paths fail with "File is not part of this snapshot" (`snapshot_path_invalid`).
- Missing Git objects make stored checkpoint metadata unusable for diffs; there is no repair flow.

## Architecture

| Piece | Location | Responsibility |
| --- | --- | --- |
| Feature module | `src/features/timeline/` | Rules: read-only project history, opt-in, import eligibility, structural baselines, visibility application, per-session serialization, run capture scheduling (`recorder.ts`). Public interface: `index.ts`. |
| Ports | `src/features/timeline/ports.ts` | `TimelineStore`, `SnapshotRepository`, `ProjectWatcher`, `TimelineCoreAccess` (narrow reads of sessions and project lock state). |
| Git adapter | `src/adapters/timeline/git-snapshots.ts` | Temporary-index capture, ref reads, history parsing, changed paths, ignore checks, per-file patches. |
| Watcher adapter | `src/adapters/timeline/fs-watcher.ts` | Recursive `fs.watch`, dropping `.git` events so Timeline's own writes never trigger observations. |
| Store | `src/adapters/storage/json-timeline-store.ts` | `timeline.json` (schema 1) in the data directory: per-session `enabled`, `importTruncated`, and the checkpoint index. |
| Composition | `src/composition/application.ts` | Assembles Timeline (default on; `timeline: false` omits it) and adapts Sessions/Projects to `TimelineCoreAccess`. |
| Host | `src/desktop/host/host-api.ts`, `active-runs.ts` | `timeline.*` commands; `runs.start` captures the run-start state before `execution.start`; `ActiveRuns` feeds events to the observer and finishes it after `run.finished`. |
| Renderer | `src/desktop/renderer/features/timeline-panel.ts`, `timeline-tree.ts` | Current branch and All branches views, shared file trees and previews. |

Core sessions, execution, and projects do not import Timeline. Timeline consumes them only through `TimelineCoreAccess`, built in composition from public service calls. Timeline's data lives in its own document, so disabling or omitting the feature leaves core records untouched.

### Desktop contract

| Command | Params | Result |
| --- | --- | --- |
| `timeline.status` | `sessionId` | `TimelineStatus` (`supported`, `reason?`, `enabled`, `importTruncated`, `captureError?`) |
| `timeline.setEnabled` | `sessionId`, `enabled` | `TimelineStatus`; enabling imports first |
| `timeline.checkpoints` | `sessionId` | `{ status, checkpoints }`, oldest first, visible checkpoints only |
| `timeline.fileDiff` | `sessionId`, `checkpointId`, `path` | Bounded patch (400,000 characters) with `status`, `truncated`, and a notice for binary or metadata-only changes |
| `timeline.projectHistory` | `projectId`, optional `mode` (`current`/`all`) | Capability and bounded visible Git/session history, oldest first, without recording opt-in |
| `timeline.setProjectEnabled` | `projectId`, `enabled` | Persisted automatic observation pause/resume; history is kept |
| `timeline.projectFileDiff` | `projectId`, `checkpointId`, `path` | Patch only for a currently reachable history entry and visible changed path in this project |
| `timeline.snapshot` | `scope` (`project`/`session`), `contextId`, `checkpointId` | Snapshot metadata and the visible union of before/after file trees, including unchanged and deleted paths |
| `timeline.snapshotFile` | snapshot target plus `path` | Exact before/after contents and bounded diff, restricted to a visible tree member |
| `timeline.snapshotHistory` | snapshot target | Recent same-repository branch navigation options with validated targets, plus the initially opened checkpoint |
| `projects.branches` | `projectId` | Current project checkout, dirty state, local/remote branches and worktree occupancy |
| `projects.checkoutBranch` | `projectId`, exact `ref`, `expectedHead` | Explicit guarded checkout; returns refreshed branch state |

The desktop shell bridge `openTimelineWindow` validates the target through the host before opening the fixed bundled page in a sandboxed native window. Only app identities and an optional initial file selection cross this boundary; callers cannot supply a URL, working-directory path or Git revision.

The event `timeline.changed { sessionId }` signals new checkpoints or setting changes. New error codes: `feature_unavailable`, `timeline_busy`, `timeline_unsupported`, `snapshot_not_found`, `snapshot_path_invalid`, and `branch_operation_failed`.

## Decisions and deviations from the specification

1. **Baselines are structural.** A snapshot is a baseline only when it has no predecessor, not because of its label. A later run's first observation is labelled `Run started` and keeps between-run changes as an ordinary checkpoint, both live and after recovery from refs. This resolves the specification's open question (section 18, recommendation 3). The label-based filter still applies to external records whose structure Rack did not write.
2. **Capture failure is reported, not latched.** The specification marks the capability unavailable after a failed capture without a recovery path (recommendation 7). Rack shows the error and retries on the next run.
3. **Own ref namespace.** Rack writes `refs/rack-timeline/`. It reads `refs/codex-timeline/<id>` only for imported Codex sessions and never writes other namespaces.
4. **Checkpoint index ownership.** Checkpoint metadata lives in Timeline's own `timeline.json`, not in session records, so the optional feature never rewrites core data.
5. **Newest-first list.** The specification does not fix the order. The side panel shows the newest checkpoint first and open by default.
6. **"Import timeline" wording kept.** The specification's contract is retained; the copy explains that it also starts recording (recommendation 1 remains open).

## Not implemented

These specification areas are not available. Several depend on capabilities Rack does not have yet:

- **Additional project history grouping**: grouping identical trees across distinct commits and an uncommitted working-tree entry. Existing HEAD history, supported timeline refs, and four-second polling are implemented.
- **Line origins**. The standalone viewer, snapshot navigation dropdown, before/after/diff/full-context dropdown and All files are implemented.
- **Content search** across snapshot code and diffs, and **review notes**. Proposed as phase 4.
- **AI snapshot review**, **editor-save checkpoints**, and **Edit from a historical view**: Rack has no in-app editor or review-run infrastructure.
- **Account-switch checkpoints** (`Manual switch settled`, `Quota switch settled`): Rack has no mid-run account switching.
- **Snapshot selector in Changes/Files/Code tabs**: Rack has no Files or Code inspector.
- Rollback or restoration, retention or pruning, remote backup, comparison of arbitrary snapshots, and non-Git folders. Project observations while no run is active are implemented.

## Open architecture items

- **Plugin toggle ownership.** Settings still controls surface visibility only. Automatic project observation uses host-owned per-project Pause/Resume; per-session run capture has its own opt-in. Hiding the panel does not pause either. Moving the global surface toggle to host-owned worker enablement remains separate work.
- **Project relinking and recording reset policy.** Explicit checkout is available above. A session's recording chain still follows its ref across branch switches; there is no automatic reset policy, and a relinked project can leave checkpoints pointing at objects in the former repository.
- **Retention.** Snapshots and index entries accumulate without pruning.

## Acceptance coverage

Automated tests (`src/features/timeline/service.test.ts`, `src/desktop/host/timeline.test.ts`) use real Git repositories in temporary folders and cover:

- T01 (disabled by default) and T03 (persisted enablement and exact-session import).
- T04 (no duplicates on repeat import) and T05 (similar ref prefixes ignored).
- T06 (independent sessions; blocked while busy) and T07 (disabled sessions do not advance the ref).
- T08 (HEAD, branch, index bytes, and working files unchanged with staged and unstaged edits) and T09 (identical tree creates no checkpoint).
- T10 (created-then-deleted file remains inspectable) and T13 (repository without HEAD).
- T14 (capture failure: run completes, error reported, preference kept).
- Visibility filtering, external Codex refs and baselines, error messages, watcher coalescing, and `feature_unavailable` when not assembled.

T02's editor half, T11 to T12, and T15 to T20 belong to the unimplemented phases.

## Pull request comparisons

The Pull Requests page can sync the complete merge-base-to-head PR tree into project history and open it in the existing snapshot viewer. Local immutable comparisons live under `refs/rack-pr-timeline/*`; fetched objects use `refs/rack-pr-objects/*`. Refreshing a previously synced PR detail updates changed head/base commits, retaining older comparison versions. A Pull Requests control in the Timeline header opens reviews for the viewed project, including nested repository selections. See [Pull requests and Usage](pull-requests.md) for provider support, credentials and refresh boundaries.


### Background work reduction (2026-10-19)

Native watches are shared by repository root. Filesystem events are batched
for Git ignore checks, so ignored build/dependency files do not request full
captures. Unknown filenames, ignore-file changes and failed ignore checks
conservatively trigger capture. Healthy project roots are revalidated every
30 seconds; watch failure retains the existing polling fallback.

Capture reuses private index stat data (at most 4 MiB per repository and
16 MiB total). Each capture still uses its own temporary index and checks
current ignores before staging; edits, deletions and newly ignored/unignored
files retain their previous semantics. Tool-boundary checkpoints remain
serialized and are not dropped. Hiding the panel does not pause recording;
Pause/Resume remains the explicit host-owned control. Hidden windows skip
Timeline UI polling.

## Concurrent session capture

Isolated sessions record their own worktree after setup and before provider execution. Timeline enable/disable is blocked only by a run in that same session. Saved session snapshots remain readable through the main repository after a worktree is removed. Project history and background tracking still observe the main checkout. Shared sessions can capture overlapping edits from other shared sessions; these observations do not establish exclusive authorship.
