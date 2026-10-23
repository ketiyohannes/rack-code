# Changes panel

Updated 2026-10-21. The right-hand Changes surface is a Git source-control view modelled on [VS Code's Source Control view](https://code.visualstudio.com/docs/sourcecontrol/overview). It tracks the working tree and index of the selected repository, and it can stage, unstage, discard, commit, push, pull, sync, fetch, create branches, switch branches and merge. It shows Git state only. Timeline is a separate project-history tool.

## Layout

Each repository section has:

- **Heading.** The repository name, a **branch button** (Switch branch, Create branch, Merge into current branch, and Abort merge while a merge is in progress), a **sync button** and a **More Git actions** menu. The sync button shows behind/ahead counts against the upstream (for example `2↓ 1↑`) and runs Sync. A branch without an upstream shows **Publish** instead. Detached HEADs and repositories without a commit show no sync button.
- **Commit box.** A message field that grows with its content (⌘Enter or Ctrl+Enter commits) and a primary button whose label states what will happen:
  - **Commit** commits the staged changes.
  - **Commit all** stages every change in the folder, then commits. This is VS Code's "smart commit" made explicit, so it needs no confirmation.
  - **Commit merge** concludes a merge. It is enabled once no conflicted files remain, and an empty message uses Git's prepared merge message.
  - The caret next to it offers **Commit & Push** (or **Commit & Publish**), **Commit & Sync** and **Amend last commit**.
  - Drafts are kept per repository while the panel polls, switches tabs or re-renders, and are cleared after a successful commit.
- **Status line.** A spinner with the running operation ("Pushing…"), then the outcome. Success lines clear after six seconds. Errors carry Git's own explanation, stay until dismissed, and have credentials in remote URLs redacted.
- **Merge banner.** Shown while `MERGE_HEAD` exists. It counts the unresolved files and has **Abort**.
- **Merge Changes, Staged Changes and Changes.** Collapsible groups with counts, file names, parent folders and status letters (M/A/D/R/C/U/T/!). A partially staged file appears in both Staged Changes and Changes.

### File and group actions

Hovering or focusing a row shows its actions before the status letter:

| Group | Row actions | Group header actions |
| --- | --- | --- |
| Merge Changes | Open file, Stage (mark resolved) | Stage all conflicted files |
| Staged Changes | Open file, Unstage | Unstage all |
| Changes | Open file, Discard (Delete for untracked files), Stage | Discard all, Stage all |

The same actions, plus **Open changes**, are in the row's context menu: right-click, Shift+F10 or the ContextMenu key. Row buttons stay out of the tab order, so arrow keys move between rows and the context menu is the keyboard path to the actions. **More Git actions** repeats Pull, Push or Publish, Sync, Fetch, Amend, Stage all, Unstage all and Discard all.

Discard asks for confirmation, and the dialog focuses Cancel. Tracked files return to their staged or last committed version, and untracked files are deleted. Ignored files are never deleted. Conflicted files cannot be discarded: stage them once resolved, or abort the merge. Amending a commit that is already on the upstream asks first, because the next push would need a force push, which Rack does not perform.

Click a file to open its diff below the lists. Staged entries compare HEAD with the index, Changes entries compare the index with the working tree, and untracked text is shown as a new file. Merge Changes compare the current branch's conflict stage with the working file. The viewer has old/new line numbers, addition and deletion backgrounds, hunk headings and an inline/split toggle. In split mode, each half has its own horizontal viewport and both follow the same vertical position. Open file uses the desktop's safe open/reveal behavior. Deleted files keep the diff but cannot be opened.

## Operation semantics

| Operation | Git behavior |
| --- | --- |
| Stage / Stage all | `git add -A` on the paths, or on the folder (`.`). Includes deletions and untracked files. Stage all switches to the listed paths while conflicts exist or the list was truncated, so conflicted files are never swept in. |
| Unstage / Unstage all | `git reset` to HEAD. Before the first commit, `git rm --cached`. A staged rename also restores its old path. Working files are untouched. |
| Discard / Discard all | `git restore --worktree` for tracked files and `git clean -f` for untracked ones. Without `-x`, so ignored files are kept. |
| Commit | `git commit -F -` with the message on stdin, or `--no-edit` for amend or merge. **Commit all** runs `git add -A -- .` first. When the selected folder is a repository subfolder and files outside it are staged, the commit is refused, because those hidden files would be committed too. |
| Push / Publish | Plain `git push` when an upstream exists, which respects `push.default`. Otherwise `git push --set-upstream <remote> HEAD`, using the branch's push remote, then `remote.pushDefault`, then `origin`, then the only remote. With several remotes and none of those configured, Rack asks you to set `remote.pushDefault`. |
| Pull | `git pull --no-edit`. Your `pull.rebase`/`pull.ff` settings apply. Without them, Rack passes `--no-rebase` (merge) instead of failing on divergent branches. A branch without an upstream must be published first. |
| Sync | Pull (when tracking), then push. Stops if the pull leaves conflicts. |
| Fetch | `git fetch --all`. |
| Merge | `git merge --no-edit` of a ref from the branch list (`refs/heads/*` or `refs/remotes/*`), with Git's usual "Merge branch 'x'" message. Conflicts are a normal outcome: the merge stays in progress and the banner appears. |
| Abort merge | `git merge --abort`. |
| Create branch | Validated with `git check-ref-format --branch`, then `git switch -c`. Staged and working changes come along. |
| Switch branch | The existing `projects.checkoutBranch` checkout. Refuses dirty trees, stale HEADs and branches checked out in another worktree. Remote branches create a local tracking branch. Never fetches. |

User hooks (pre-commit, commit-msg, pre-push, post-merge) run, as they do in the Git CLI and VS Code. Commit signing follows your Git configuration.

### Safety

- Git runs without a shell. Paths are passed after `--` with `--literal-pathspecs`, so names such as `*.txt`, `:x` or `-dash.txt` are literal. Absolute paths, `..` segments and NUL are rejected before Git starts. Discovered repository folders are revalidated for containment on every call.
- Inherited repository redirection (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, config overrides, pathspec mode variables) is removed.
- Git never prompts. `GIT_TERMINAL_PROMPT=0` is set, a no-op editor is used, and on macOS and Linux Git runs in its own session without a controlling terminal, so SSH and credential prompts fail instead of waiting on the terminal that launched Rack. Credential helpers such as the macOS keychain and `gh` keep working.
- Local operations time out after 30 seconds, commits and merges (hooks, signing) after 3 minutes, and network operations after 3 minutes. A timeout kills the whole process group.
- Operations on one working tree are serialized in the host, and the panel runs one operation per repository at a time.
- **Active runs.** Pull, Sync, Merge and Abort merge rewrite working files, so they are refused while any run writes in the same working tree. Working trees are compared by canonical root, so aliases of one checkout match, while separate worktrees of one repository do not. During the check, new runs are briefly refused, as during a branch checkout. Stage, unstage, commit, push, fetch and discard stay available while an agent runs, as in VS Code.
- **Isolated sessions.** For an isolated session the panel operates in the session's worktree. Commit, stage, push (which publishes the `rack/<id>` branch) and merge work there. **Create branch** and **Switch branch** are disabled: the worktree record names the branch it is restored from, and switching would make a later restore check out different work.

## Reading and polling

Reads start at a two-second interval while visible, back off to ten seconds when unchanged, and refresh immediately after every operation. Manual refresh and project/run transitions are also immediate. Hidden windows skip polling and refresh on return. Stale replies cannot cross projects or repository selections. Selection, section expansion, commit drafts, diff scroll positions and focus survive refreshed snapshots, including focus and caret in the commit box. A refresh that arrives during IME composition waits until composition ends. Switching projects clears the previous project's selections, drafts and outcome lines.

Upstream, ahead/behind and merge state come from the same `git status --branch` and `git rev-parse` processes the panel already ran, so the new header adds no Git processes per poll. A gone upstream is treated as unpublished, so the branch can be published again.

Multiple detected repositories can be selected individually or viewed together. Refresh and the panel's repository-options menu keep discovery controls available.

## Ownership and bounds

Projects owns both contracts:

- **`ProjectChanges` (read-only).** `projects.changes` returns application-owned `ProjectChangeFile` records with a scoped path, status, group, per-file patch, optional previous path and preview notice. It also returns optional `branch`, `upstream`, `ahead`, `behind`, `merging` and `hasCommits` fields. The Git adapter interprets [NUL-delimited porcelain status](https://git-scm.com/docs/git-status#_porcelain_format_version_1); the renderer never parses native XY codes. Status rows are limited to 500 per repository, new-file previews to 50 files and 128 KB each, and per-file previews share a 1-million-character budget. `GIT_OPTIONAL_LOCKS=0`, disabled external diff drivers and disabled text conversion keep background reads from rewriting the index.
- **Explicit operations.** `projects.sourceControl` carries one `SourceControlAction` (see `packages/core/src/projects/types.ts`). It is implemented by `ProjectsService.sourceControl` through the `ProjectSourceControl` port and the `GitSourceControl` adapter (`packages/node-adapters/src/git/git-source-control.ts`). The host builds the typed action from the wire shape and rejects a missing per-kind field, so a missing `paths` can never widen a discard to everything. `projects.branches` and `projects.checkoutBranch` accept an optional `repositoryPath` (and, for listing only, `sessionId`), so branch dialogs target the folder the panel shows. Failures use the `git_operation_failed` host error code.

The workbench owns discovery, polling, per-repository operation state and view memory. `features/changes-view.ts` owns rendering, dialogs and menus. `components/action-menu.ts` provides the keyboard-navigable menus, and `change-diff.ts` owns numbered-row and split alignment. After each operation the host emits `projects.changed` and `timeline.changed`, so Timeline and other windows pick up new commits and branches.

## Not implemented

- Force push, rebase, cherry-pick, stash, tags, and creating or removing remotes.
- Partial (hunk or line) staging.
- Choosing a remote when several exist and none is configured (set `remote.pushDefault`).
- Interactive credential or SSH passphrase prompts. Use a credential helper or an SSH agent.
- Live checks against real hosted remotes. The automated tests use local bare repositories.
