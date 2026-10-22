/**
 * Changes panel presentation: a Git source-control view modelled on VS
 * Code's. Per repository it renders a heading (branch menu, sync/publish,
 * repository actions), a commit box, Merge Changes / Staged Changes /
 * Changes lists with per-file and per-group actions, and one selected file's
 * numbered diff.
 *
 * This module only renders and asks for operations. Git work happens in the
 * host (`projects.sourceControl`, `projects.checkoutBranch`); the workbench
 * owns polling, memory and the in-flight/result state of each repository, so
 * polling preserves selections, collapsed sections, commit drafts and focus.
 *
 * Destructive or history-rewriting actions (discard, amend of a pushed
 * commit) ask for confirmation. Every action is also available from the
 * file row's context menu (right-click, Shift+F10 or the ContextMenu key),
 * so the hover-only row buttons are not the sole keyboard path.
 */
import type {
  CommandParams,
  ProjectBranches,
  ProjectChangeFile,
  ProjectChangeGroup,
  ProjectChanges,
  ProjectChangeStatus,
} from "../../../contracts/desktop/index.js";
import { openActionMenu, type ActionMenuItem } from "../components/action-menu.js";
import { createDropdown } from "../components/dropdown.js";
import { openModal } from "../components/modal.js";
import { h } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { diffFiles, diffRows, splitDiffRows, type DiffRow } from "./change-diff.js";

export type SourceControlRequest = CommandParams<"projects.sourceControl">["action"];

/** Outcome line under the commit box; success lines expire, errors stay. */
export interface ChangesResult {
  readonly text: string;
  readonly tone: "success" | "warning" | "error";
}

export interface ChangesMemory {
  readonly selectedFiles: Map<string, string>;
  readonly collapsedGroups: Set<string>;
  split: boolean;
  /** Commit message drafts per repository key. */
  readonly messages: Map<string, string>;
  /**
   * Commit boxes per repository key. The surface is rebuilt on every poll;
   * reusing the element keeps its value, undo history and caret, and the
   * workbench restores focus after re-attaching it.
   */
  readonly commitBoxes: Map<string, HTMLTextAreaElement>;
  /** Label of the running operation per repository key ("Pushing…"). */
  readonly pending: Map<string, string>;
  readonly results: Map<string, ChangesResult>;
  /** True during IME composition in a commit box; the workbench defers re-renders until it ends. */
  composing: boolean;
  renderDeferred: boolean;
}

export function createChangesMemory(): ChangesMemory {
  return { selectedFiles: new Map(), collapsedGroups: new Set(), split: false, messages: new Map(), commitBoxes: new Map(),
    pending: new Map(), results: new Map(), composing: false, renderDeferred: false };
}

/** Drops per-project state when the panel switches folders; drafts of the old folder are discarded with it. */
export function clearChangesMemory(memory: ChangesMemory): void {
  memory.selectedFiles.clear(); memory.collapsedGroups.clear(); memory.messages.clear(); memory.commitBoxes.clear();
  memory.pending.clear(); memory.results.clear(); memory.composing = false; memory.renderDeferred = false;
}

const GROUPS: readonly { id: ProjectChangeGroup; label: string }[] = [
  { id: "conflicts", label: "Merge Changes" }, { id: "staged", label: "Staged Changes" }, { id: "changes", label: "Changes" },
];
const STATUS: Record<ProjectChangeStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" }, added: { letter: "A", label: "Added" }, deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" }, copied: { letter: "C", label: "Copied" }, untracked: { letter: "U", label: "Untracked" },
  conflicted: { letter: "!", label: "Conflict" }, type_changed: { letter: "T", label: "Type changed" },
};

interface RepositoryViewInput {
  readonly key: string;
  readonly label: string;
  readonly snapshot?: ProjectChanges;
  readonly error?: string;
  readonly memory: ChangesMemory;
  readonly redraw: () => void;
  readonly openFile: (path: string) => void;
  /** Isolated session worktrees keep their recorded branch: no branch creation or switching. */
  readonly isolated: boolean;
  /** Runs one operation with a progress label; resolves true on success. The workbench records the outcome. */
  readonly act: (request: SourceControlRequest, label: string) => Promise<boolean>;
  readonly loadBranches: () => Promise<ProjectBranches>;
  /** Switches the checkout; tracked like `act`. */
  readonly checkout: (ref: string, expectedHead: string, label: string) => Promise<boolean>;
}

/** Older hosts only have the combined patch; show its files without guessing staging. */
function filesFor(snapshot: ProjectChanges): readonly ProjectChangeFile[] {
  return snapshot.files ?? diffFiles(snapshot.diff).map((file) => ({
    path: file.title, group: "changes", diff: file.lines.join("\n"),
    status: file.lines.some((line) => line.startsWith("new file")) ? "added" : file.lines.some((line) => line.startsWith("deleted file")) ? "deleted" : "modified",
  }));
}

const fileKey = (file: ProjectChangeFile) => `${file.group}:${file.path}`;
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

export function renderRepositoryChanges(input: RepositoryViewInput): HTMLElement {
  const { memory, snapshot } = input;
  const files = snapshot === undefined ? [] : filesFor(snapshot);
  const selected = files.find((file) => fileKey(file) === memory.selectedFiles.get(input.key));
  const ready = input.error === undefined && snapshot?.status === "ready";
  const busy = memory.pending.has(input.key);
  // Older hosts send no per-file groups; their snapshot is read-only.
  const actionable = ready && !busy && snapshot?.files !== undefined;
  const section = h("section", { class: "git-repository", aria: { label: input.label, busy: String(busy) }, data: { repositoryKey: input.key } },
    renderHeading(input, files, ready && snapshot?.files !== undefined, busy));
  if (!ready || snapshot === undefined) {
    section.append(h("p", { class: input.error === undefined ? "git-empty" : "error-line" }, input.error ?? (snapshot === undefined ? "Loading changes…" : snapshot.status === "not_git" ? "This folder is not a Git repository." : "Repository unavailable. Rescan to refresh it.")));
    return section;
  }
  if (snapshot.merging) section.append(renderMergeBanner(input, files, actionable));
  if (snapshot.files !== undefined) section.append(renderCommitBox(input, files, actionable));
  const status = renderStatusLine(input);
  if (status !== null) section.append(status);
  for (const group of GROUPS) {
    const entries = files.filter((file) => file.group === group.id).sort((a, b) => a.path.localeCompare(b.path));
    if (entries.length === 0 && group.id !== "changes") continue;
    const key = `${input.key}:${group.id}`;
    const details = h("details", { class: "git-change-group", open: !memory.collapsedGroups.has(key) },
      h("summary", {}, icon("caret-right", { className: "activity-caret" }), h("span", { class: "git-group-label" }, group.label),
        actionable && entries.length > 0 ? h("span", { class: "git-row-actions git-group-actions" }, ...groupActions(input, group.id, entries, files)) : null,
        h("span", { class: "git-group-count" }, entries.length)),
      h("div", { class: "git-file-list", role: "list", aria: { label: group.label } }, ...entries.map((file) => renderRepositoryFileRow(input, file, file === selected, actionable))),
    );
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      if (details.open) memory.collapsedGroups.delete(key); else memory.collapsedGroups.add(key);
    });
    section.append(details);
  }
  if (files.length === 0) section.append(h("p", { class: "git-empty" }, "No changes"));
  if (snapshot.truncated) section.append(h("p", { class: "git-preview-note" }, "Some large changes were shortened for preview."));
  if (selected !== undefined) section.append(renderDiff(selected, input));
  section.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("git-file-row")) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const file = files.find((candidate) => candidate.path === target.dataset["changePath"] && candidate.group === target.dataset["changeGroup"]);
      if (file !== undefined && actionable) { event.preventDefault(); openFileMenu(input, file, target); }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...section.querySelectorAll<HTMLButtonElement>(".git-file-row")].filter((row) => row.getClientRects().length > 0);
    const current = rows.indexOf(target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
    event.preventDefault(); rows[next]?.focus();
  });
  return section;
}

/** Repository name, branch menu, ahead/behind sync (or publish), and repository actions. */
function renderHeading(input: RepositoryViewInput, files: readonly ProjectChangeFile[], ready: boolean, busy: boolean): HTMLElement {
  const snapshot = input.snapshot;
  const heading = h("div", { class: "git-repository-heading" }, icon("git-branch"),
    h("span", { class: "git-repository-name", title: input.label }, input.label));
  if (!ready || snapshot === undefined) {
    if (snapshot?.branch !== undefined) heading.append(h("span", { class: "git-branch-name", title: snapshot.branch }, snapshot.branch));
    return heading;
  }
  const branchLabel = snapshot.branch ?? "No branch";
  const branchButton: HTMLButtonElement = h("button", {
    class: "git-branch-button", type: "button", disabled: busy, title: `${branchLabel} · Branch actions`,
    aria: { label: `Branch ${branchLabel}. Branch actions`, haspopup: "menu" },
    onClick: () => openActionMenu({ anchor: branchButton, label: "Branch actions", align: "start", items: branchItems(input, files) }),
  }, h("span", { class: "git-branch-name" }, branchLabel), icon("caret-down"));
  heading.append(branchButton);
  const sync = syncButton(input, busy);
  if (sync !== null) heading.append(sync);
  const more: HTMLButtonElement = h("button", {
    class: "icon-button", type: "button", disabled: busy, aria: { label: `More Git actions for ${input.label}`, haspopup: "menu" },
    title: "More Git actions", onClick: () => openActionMenu({ anchor: more, label: "Git actions", items: repositoryItems(input, files) }),
  }, icon("dots-three"));
  heading.append(more);
  return heading;
}

/** VS Code's status-bar sync: arrows with counts when tracking, Publish otherwise. */
function syncButton(input: RepositoryViewInput, busy: boolean): HTMLButtonElement | null {
  const snapshot = input.snapshot!;
  const detached = snapshot.branch === undefined || /^[0-9a-f]{7,40}$/.test(snapshot.branch);
  if (detached || snapshot.hasCommits === false) return null;
  if (snapshot.upstream === undefined) {
    return h("button", { class: "git-sync-button", type: "button", disabled: busy, title: `Publish ${snapshot.branch} to a remote and track it`,
      aria: { label: `Publish branch ${snapshot.branch}` }, onClick: () => void input.act({ kind: "push" }, "Publishing…") },
    icon("cloud-arrow-up"), h("span", {}, "Publish"));
  }
  const behind = snapshot.behind ?? 0, ahead = snapshot.ahead ?? 0;
  const description = behind === 0 && ahead === 0 ? `Up to date with ${snapshot.upstream}` : `Pull ${behind} and push ${ahead} commit${behind + ahead === 1 ? "" : "s"} with ${snapshot.upstream}`;
  return h("button", { class: `git-sync-button${behind + ahead > 0 ? " pending" : ""}`, type: "button", disabled: busy,
    title: `Sync changes. ${description}`, aria: { label: `Sync changes. ${description}` },
    onClick: () => void input.act({ kind: "sync" }, "Syncing…") },
  icon("arrows-clockwise"), h("span", { class: "git-sync-count" }, `${behind}`, icon("arrow-down")), h("span", { class: "git-sync-count" }, `${ahead}`, icon("arrow-up")));
}

function branchItems(input: RepositoryViewInput, files: readonly ProjectChangeFile[]): (ActionMenuItem | null)[] {
  const snapshot = input.snapshot!;
  const isolatedNote = "Isolated sessions keep their own branch. Use the project checkout to change branches.";
  return [
    { label: "Switch branch…", icon: "git-branch", disabled: input.isolated, ...(input.isolated ? { title: isolatedNote } : {}), run: () => openBranchDialog(input, "switch") },
    { label: "Create branch…", icon: "plus", disabled: input.isolated, ...(input.isolated ? { title: isolatedNote } : {}), run: () => openCreateBranchDialog(input) },
    null,
    { label: snapshot.branch ? `Merge into ${snapshot.branch}…` : "Merge branch…", icon: "git-merge",
      disabled: snapshot.merging === true || files.some((file) => file.group === "conflicts"), run: () => openBranchDialog(input, "merge") },
    ...(snapshot.merging ? [{ label: "Abort merge", icon: "x" as const, danger: true, run: () => void input.act({ kind: "abortMerge" }, "Aborting merge…") }] : []),
  ];
}

function repositoryItems(input: RepositoryViewInput, files: readonly ProjectChangeFile[]): (ActionMenuItem | null)[] {
  const snapshot = input.snapshot!;
  const tracking = snapshot.upstream !== undefined;
  const changes = files.filter((file) => file.group === "changes");
  const staged = files.filter((file) => file.group === "staged");
  return [
    { label: "Pull", icon: "arrow-down", disabled: !tracking, ...(tracking ? {} : { title: "Publish the branch first." }), run: () => void input.act({ kind: "pull" }, "Pulling…") },
    { label: tracking ? "Push" : "Publish branch", icon: tracking ? "arrow-up" : "cloud-arrow-up", disabled: snapshot.hasCommits === false,
      run: () => void input.act({ kind: "push" }, tracking ? "Pushing…" : "Publishing…") },
    { label: "Sync", icon: "arrows-clockwise", disabled: snapshot.hasCommits === false, run: () => void input.act({ kind: "sync" }, "Syncing…") },
    { label: "Fetch", icon: "arrow-clockwise", run: () => void input.act({ kind: "fetch" }, "Fetching…") },
    null,
    { label: "Amend last commit…", icon: "pencil-simple", disabled: snapshot.hasCommits === false || snapshot.merging === true, run: () => void commit(input, files, { amend: true }) },
    null,
    { label: "Stage all changes", icon: "plus", disabled: changes.length === 0, run: () => void stageGroup(input, changes, files) },
    { label: "Unstage all changes", icon: "minus", disabled: staged.length === 0, run: () => void input.act({ kind: "unstageAll" }, "Unstaging…") },
    { label: "Discard all changes…", icon: "arrow-counter-clockwise", danger: true, disabled: changes.length === 0, run: () => confirmDiscard(input, changes) },
  ];
}

function renderMergeBanner(input: RepositoryViewInput, files: readonly ProjectChangeFile[], actionable: boolean): HTMLElement {
  const conflicts = files.filter((file) => file.group === "conflicts").length;
  return h("div", { class: "git-merge-banner", role: "status" }, icon("git-merge"),
    h("span", {}, conflicts > 0 ? `Merge in progress. Resolve ${conflicts} conflicted file${conflicts === 1 ? "" : "s"}, stage ${conflicts === 1 ? "it" : "them"}, then commit.` : "Merge in progress. All conflicts are staged; commit to finish the merge."),
    h("button", { class: "button button-small", type: "button", disabled: !actionable, onClick: () => void input.act({ kind: "abortMerge" }, "Aborting merge…") }, "Abort"));
}

/** What the primary commit button does in the current state. */
function commitMode(snapshot: ProjectChanges, files: readonly ProjectChangeFile[]): { label: string; enabled: boolean; all: boolean; needsMessage: boolean; reason?: string } {
  const staged = files.some((file) => file.group === "staged");
  const changes = files.some((file) => file.group === "changes");
  const conflicts = files.some((file) => file.group === "conflicts");
  if (snapshot.merging) return conflicts ? { label: "Commit merge", enabled: false, all: false, needsMessage: false, reason: "Stage every conflicted file first." }
    : { label: "Commit merge", enabled: true, all: false, needsMessage: false };
  // VS Code's smart commit, made explicit: with nothing staged, commit everything.
  if (staged) return { label: "Commit", enabled: true, all: false, needsMessage: true };
  if (changes) return { label: "Commit all", enabled: true, all: true, needsMessage: true };
  return { label: "Commit", enabled: false, all: false, needsMessage: true, reason: "There are no changes to commit." };
}

function renderCommitBox(input: RepositoryViewInput, files: readonly ProjectChangeFile[], actionable: boolean): HTMLElement {
  const { memory, snapshot } = input;
  const mode = commitMode(snapshot!, files);
  let box = memory.commitBoxes.get(input.key);
  if (box === undefined) {
    const created: HTMLTextAreaElement = h("textarea", { class: "git-commit-message", rows: 1, aria: { label: `Commit message for ${input.label}` } });
    created.value = memory.messages.get(input.key) ?? "";
    created.addEventListener("input", () => { memory.messages.set(input.key, created.value); syncCommitButton(created); });
    created.addEventListener("compositionstart", () => { memory.composing = true; });
    created.addEventListener("compositionend", () => {
      memory.composing = false;
      if (memory.renderDeferred) { memory.renderDeferred = false; input.redraw(); }
    });
    created.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
        event.preventDefault();
        created.closest(".git-commit")?.querySelector<HTMLButtonElement>(".git-commit-button")?.click();
      }
    });
    memory.commitBoxes.set(input.key, created);
    box = created;
  }
  // The branch is already in the heading; a short placeholder fits a narrow panel on one line.
  box.placeholder = snapshot!.merging ? "Message (optional for a merge)" : `Message (${isMac ? "⌘" : "Ctrl+"}Enter to commit)`;
  box.title = snapshot!.branch ? `Commit message for '${snapshot!.branch}'` : "Commit message";
  const button = h("button", {
    class: "button button-primary button-small git-commit-button", type: "button", data: { needsMessage: String(mode.needsMessage) },
    disabled: !actionable || !mode.enabled || (mode.needsMessage && box.value.trim() === ""),
    title: mode.reason ?? (mode.all ? "Stage all changes and commit them" : mode.label),
    onClick: () => void commit(input, files, {}),
  }, icon("check"), h("span", {}, mode.label));
  const tracking = snapshot!.upstream !== undefined;
  const menuButton: HTMLButtonElement = h("button", {
    // Every commit variant except amend needs the same message, and amend
    // stays available from the repository menu, so the caret mirrors Commit.
    class: "button button-primary button-small git-commit-more", type: "button", disabled: !actionable || !mode.enabled || (mode.needsMessage && box.value.trim() === ""),
    aria: { label: "More commit actions", haspopup: "menu" }, title: "More commit actions",
    onClick: () => openActionMenu({ anchor: menuButton, label: "Commit actions", items: [
      { label: tracking ? "Commit & Push" : "Commit & Publish", icon: tracking ? "arrow-up" : "cloud-arrow-up", run: () => void commit(input, files, { then: "push" }) },
      { label: "Commit & Sync", icon: "arrows-clockwise", disabled: !tracking, run: () => void commit(input, files, { then: "sync" }) },
      null,
      { label: "Amend last commit…", icon: "pencil-simple", disabled: snapshot!.hasCommits === false || snapshot!.merging === true, run: () => void commit(input, files, { amend: true }) },
    ] }),
  }, icon("caret-down"));
  return h("div", { class: "git-commit" }, box, h("div", { class: "git-commit-actions" }, button, menuButton));
}

/** Enables the commit button as the message changes, without a full re-render. */
function syncCommitButton(box: HTMLTextAreaElement): void {
  const button = box.closest(".git-commit")?.querySelector<HTMLButtonElement>(".git-commit-button");
  if (button === undefined || button === null || button.dataset["needsMessage"] !== "true") return;
  const section = box.closest(".git-repository");
  const blocked = section?.getAttribute("aria-busy") === "true" || button.title === "There are no changes to commit.";
  button.disabled = blocked || box.value.trim() === "";
  const more = box.closest(".git-commit")?.querySelector<HTMLButtonElement>(".git-commit-more");
  if (more) more.disabled = button.disabled;
}

/**
 * Commits with the current draft, then optionally pushes or syncs. The draft
 * is cleared only after a successful commit. Amending a commit that is
 * already on the upstream asks first, because the next push will be rejected.
 */
async function commit(input: RepositoryViewInput, files: readonly ProjectChangeFile[], options: { readonly amend?: boolean; readonly then?: "push" | "sync" }): Promise<void> {
  const snapshot = input.snapshot!;
  const message = input.memory.messages.get(input.key) ?? "";
  const mode = commitMode(snapshot, files);
  if (!options.amend && (!mode.enabled || (mode.needsMessage && message.trim() === ""))) {
    if (mode.needsMessage && message.trim() === "") input.memory.commitBoxes.get(input.key)?.focus();
    return;
  }
  if (options.amend && snapshot.upstream !== undefined && (snapshot.ahead ?? 0) === 0) {
    const confirmed = await confirm({ title: "Amend a pushed commit?", action: "Amend", danger: false,
      body: `The last commit is already on ${snapshot.upstream}. Amending rewrites it, so pushing afterwards needs a force push, which Rack does not do.` });
    if (!confirmed) return;
  }
  const staged = files.some((file) => file.group === "staged");
  const request: SourceControlRequest = { kind: "commit", message, ...(options.amend ? { amend: true } : {}),
    // Amend without staged files only rewrites the message; never sweep in all changes.
    ...(!options.amend && mode.all ? { all: true } : {}) };
  const committed = await input.act(request, options.amend ? "Amending…" : staged || !mode.all ? "Committing…" : "Committing all changes…");
  if (!committed) return;
  input.memory.messages.delete(input.key);
  const box = input.memory.commitBoxes.get(input.key);
  if (box !== undefined) box.value = "";
  if (options.then === "push") await input.act({ kind: "push" }, snapshot.upstream === undefined ? "Publishing…" : "Pushing…");
  if (options.then === "sync") await input.act({ kind: "sync" }, "Syncing…");
}

function renderStatusLine(input: RepositoryViewInput): HTMLElement | null {
  const pending = input.memory.pending.get(input.key);
  if (pending !== undefined) return h("p", { class: "git-status-line", role: "status" }, icon("circle-notch", { className: "spin" }), h("span", {}, pending));
  const result = input.memory.results.get(input.key);
  if (result === undefined) return null;
  return h("p", { class: `git-status-line ${result.tone}`, role: result.tone === "error" ? "alert" : "status" },
    icon(result.tone === "error" ? "warning-circle" : result.tone === "warning" ? "git-merge" : "check-circle"), h("span", {}, result.text),
    h("button", { class: "icon-button", type: "button", aria: { label: "Dismiss message" }, onClick: () => { input.memory.results.delete(input.key); input.redraw(); } }, icon("x")));
}

/** Group header actions, as in VS Code: resolve all, unstage all, or stage/discard all. */
function groupActions(input: RepositoryViewInput, group: ProjectChangeGroup, entries: readonly ProjectChangeFile[], files: readonly ProjectChangeFile[]): HTMLButtonElement[] {
  const button = (name: IconName, label: string, run: () => void, danger = false) => h("button", {
    class: `icon-button git-row-action${danger ? " danger" : ""}`, type: "button", aria: { label },
    // Buttons inside <summary> would otherwise also toggle the section.
    onClick: (event) => { event.preventDefault(); event.stopPropagation(); run(); },
  }, icon(name));
  if (group === "conflicts") return [button("plus", "Stage all conflicted files (mark resolved)", () => void input.act({ kind: "stage", paths: entries.map((file) => file.path) }, "Staging…"))];
  if (group === "staged") return [button("minus", "Unstage all changes", () => void input.act({ kind: "unstageAll" }, "Unstaging…"))];
  return [
    button("arrow-counter-clockwise", "Discard all changes", () => confirmDiscard(input, entries), true),
    button("plus", "Stage all changes", () => void stageGroup(input, entries, files)),
  ];
}

/** Stage the Changes group; never sweep conflicted files in with `stageAll`. */
function stageGroup(input: RepositoryViewInput, entries: readonly ProjectChangeFile[], files: readonly ProjectChangeFile[]): Promise<boolean> {
  const conflicts = files.some((file) => file.group === "conflicts");
  return input.act(conflicts || input.snapshot?.truncated ? { kind: "stage", paths: entries.map((file) => file.path) } : { kind: "stageAll" }, "Staging…");
}

/** Index paths affected by one row: a staged rename also restores its old path. */
function rowPaths(file: ProjectChangeFile): string[] {
  return file.group === "staged" && file.previousPath !== undefined ? [file.path, file.previousPath] : [file.path];
}

function fileActions(input: RepositoryViewInput, file: ProjectChangeFile): ActionMenuItem[] {
  const open: ActionMenuItem = { label: "Open file", icon: "arrow-up-right", disabled: file.status === "deleted", run: () => input.openFile(file.path) };
  if (file.group === "conflicts") return [open, { label: "Stage (mark resolved)", icon: "plus", run: () => void input.act({ kind: "stage", paths: [file.path] }, "Staging…") }];
  if (file.group === "staged") return [open, { label: "Unstage changes", icon: "minus", run: () => void input.act({ kind: "unstage", paths: rowPaths(file) }, "Unstaging…") }];
  return [open,
    { label: file.status === "untracked" ? "Delete untracked file…" : "Discard changes…", icon: "arrow-counter-clockwise", danger: true, run: () => confirmDiscard(input, [file]) },
    { label: "Stage changes", icon: "plus", run: () => void input.act({ kind: "stage", paths: [file.path] }, "Staging…") }];
}

function openFileMenu(input: RepositoryViewInput, file: ProjectChangeFile, anchor: HTMLElement, point?: { x: number; y: number }): void {
  openActionMenu({ anchor, label: `Actions for ${file.path}`, align: "start", ...(point === undefined ? {} : { point }), items: [
    { label: "Open changes", icon: "git-diff", run: () => { input.memory.selectedFiles.set(input.key, fileKey(file)); input.redraw(); } },
    ...fileActions(input, file),
  ] });
}

/** A Changes tab row with its stage/unstage/discard actions and context menu. */
function renderRepositoryFileRow(input: RepositoryViewInput, file: ProjectChangeFile, selected: boolean, actionable: boolean): HTMLElement {
  const status = STATUS[file.status];
  const group = GROUPS.find((candidate) => candidate.id === file.group)!.label;
  const row = h("button", {
    class: `git-file-row status-${file.status}${selected ? " selected" : ""}`, type: "button", title: fileRowTitle(file),
    aria: { pressed: String(selected), label: `${file.path}, ${status.label}, ${group}` },
    data: { changePath: file.path, changeGroup: file.group }, onClick: () => {
      input.memory.selectedFiles.set(input.key, fileKey(file)); input.redraw();
    },
  }, ...fileRowContent(file.path));
  if (actionable) row.addEventListener("contextmenu", (event) => { event.preventDefault(); openFileMenu(input, file, row, { x: event.clientX, y: event.clientY }); });
  // Row buttons are pointer shortcuts and stay out of the tab order; the
  // context menu offers the same actions from the keyboard.
  const actions = actionable ? fileActions(input, file).map((action) => {
    const button = h("button", {
      class: `icon-button git-row-action${action.danger ? " danger" : ""}`, type: "button", disabled: action.disabled ?? false,
      aria: { label: `${action.label.replace(/…$/, "")}: ${file.path}` }, title: action.label.replace(/…$/, ""), onClick: () => action.run(),
    }, icon(action.icon!));
    button.tabIndex = -1;
    return button;
  }) : [];
  return h("div", { class: `git-file-item${selected ? " selected" : ""}`, role: "listitem" }, row,
    h("span", { class: "git-row-actions" }, ...actions),
    h("span", { class: `git-file-status status-${file.status}`, title: status.label }, status.letter));
}

function confirmDiscard(input: RepositoryViewInput, files: readonly ProjectChangeFile[]): void {
  if (files.length === 0) return;
  const untracked = files.filter((file) => file.status === "untracked").length;
  const single = files.length === 1 ? files[0]! : undefined;
  const title = single ? (single.status === "untracked" ? `Delete ${basename(single.path)}?` : `Discard changes in ${basename(single.path)}?`)
    : `Discard all ${files.length} changes?`;
  const body = [
    files.length - untracked > 0 ? "Tracked files return to their staged or last committed version." : "",
    untracked > 0 ? `${untracked === 1 && single ? "This untracked file" : `${untracked} untracked file${untracked === 1 ? "" : "s"}`} will be deleted.` : "",
    "This cannot be undone.",
  ].filter(Boolean).join(" ");
  void confirm({ title, body, action: single?.status === "untracked" ? "Delete file" : "Discard", danger: true }).then((confirmed) => {
    if (!confirmed) return;
    // "All" uses the scoped operation so files beyond the preview limit are included.
    if (single === undefined && !input.snapshot?.truncated) void input.act({ kind: "discardAll" }, "Discarding…");
    else void input.act({ kind: "discard", paths: files.map((file) => file.path) }, "Discarding…");
  });
}

function confirm(options: { readonly title: string; readonly body: string; readonly action: string; readonly danger: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;
    const accept = h("button", { class: `button button-small ${options.danger ? "button-danger" : "button-primary"}`, type: "button", onClick: () => { confirmed = true; modal.close(); } }, options.action);
    const modal = openModal({ title: options.title, onClose: () => resolve(confirmed), content: h("div", { class: "modal-body" },
      h("p", {}, options.body),
      h("div", { class: "modal-actions" }, h("button", { class: "button button-small", type: "button", onClick: () => modal.close() }, "Cancel"), accept)) });
    // Destructive confirmations focus Cancel, so Enter does not discard by accident.
    (options.danger ? accept.previousElementSibling as HTMLButtonElement : accept).focus();
  });
}

/** Branch picker for Switch (checkout) and Merge (into the current branch). */
function openBranchDialog(input: RepositoryViewInput, purpose: "switch" | "merge"): void {
  const current = input.snapshot?.branch;
  let catalog: ProjectBranches | undefined;
  let choice: string | undefined;
  const status = h("p", { class: "note" }, "Loading branches…");
  const accept = h("button", { class: "button button-primary button-small", type: "button", disabled: true, onClick: () => {
    const branch = catalog?.branches.find((candidate) => candidate.ref === choice);
    if (branch === undefined || catalog === undefined) return;
    modal.close();
    if (purpose === "merge") void input.act({ kind: "merge", ref: branch.ref }, `Merging ${branch.name}…`);
    else if (catalog.head !== undefined) void input.checkout(branch.ref, catalog.head, `Switching to ${branch.name}…`);
  } }, icon(purpose === "merge" ? "git-merge" : "git-branch"), h("span", {}, purpose === "merge" ? "Merge" : "Switch"));
  const picker = createDropdown<string>({ ariaLabel: purpose === "merge" ? "Branch to merge" : "Branch to switch to", placeholder: "Choose a branch", menuWidth: 320,
    onChange: (value) => { choice = value; accept.disabled = false; } });
  picker.setDisabled(true);
  const modal = openModal({ title: purpose === "merge" ? `Merge into ${current ?? "HEAD"}` : "Switch branch", content: h("div", { class: "modal-body git-branch-dialog" },
    h("p", {}, purpose === "merge" ? "Choose a branch to merge into the current branch. Conflicts stop the merge so you can resolve them here or abort."
      : "Switch this checkout to another branch. Remote branches create a local tracking branch; nothing is fetched."),
    picker.element, status,
    h("div", { class: "modal-actions" }, h("button", { class: "button button-small", type: "button", onClick: () => modal.close() }, "Cancel"), accept)) });
  input.loadBranches().then((loaded) => {
    catalog = loaded;
    const options = loaded.branches
      .filter((branch) => !(branch.kind === "local" && branch.name === loaded.current))
      .map((branch) => {
        const elsewhere = purpose === "switch" && branch.worktreePath !== undefined;
        return { value: branch.ref, label: branch.name, group: branch.kind === "local" ? "Local branches" : "Remote branches", icon: "git-branch" as const,
          description: elsewhere ? `In use: ${branch.worktreePath}` : branch.commit.slice(0, 8), disabled: elsewhere };
      });
    picker.setOptions(options);
    picker.setDisabled(options.length === 0 || (purpose === "switch" && loaded.dirty));
    status.textContent = options.length === 0 ? "There are no other branches."
      : purpose === "switch" && loaded.dirty ? "Commit or stash your changes before switching branches. Rack never discards them."
        : purpose === "switch" && loaded.head === undefined ? "Commit at least once before switching branches." : "";
    status.hidden = status.textContent === "";
  }, (error: unknown) => { status.textContent = error instanceof Error ? error.message : String(error); status.classList.add("error-line"); });
}

function openCreateBranchDialog(input: RepositoryViewInput): void {
  const field = h("input", { class: "input", type: "text", placeholder: "feature/my-change", aria: { label: "New branch name" } });
  const accept = h("button", { class: "button button-primary button-small", type: "button", disabled: true, onClick: () => submit() }, icon("plus"), h("span", {}, "Create branch"));
  const submit = () => {
    const name = field.value.trim();
    if (name === "") return;
    modal.close();
    void input.act({ kind: "createBranch", name }, `Creating ${name}…`);
  };
  field.addEventListener("input", () => { accept.disabled = field.value.trim() === ""; });
  field.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); } });
  const modal = openModal({ title: "Create branch", content: h("div", { class: "modal-body" },
    h("p", {}, `Creates a branch from ${input.snapshot?.branch ? `'${input.snapshot.branch}'` : "the current commit"} and switches to it. Your changes come along.`),
    field,
    h("div", { class: "modal-actions" }, h("button", { class: "button button-small", type: "button", onClick: () => modal.close() }, "Cancel"), accept)) });
  field.focus();
}

function renderDiff(file: ProjectChangeFile, input: RepositoryViewInput): HTMLElement {
  return renderFileDiff({
    path: file.path, status: file.status, rows: diffRows(file.diff),
    source: file.group === "staged" ? "Index" : file.group === "conflicts" ? "Conflict" : "Working Tree",
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    ...(file.notice === undefined ? {} : { notice: file.notice }),
    split: input.memory.split,
    toggleSplit: () => { input.memory.split = !input.memory.split; input.redraw(); },
    openFile: input.openFile,
    close: () => { input.memory.selectedFiles.delete(input.key); input.redraw(); },
  });
}

/**
 * One file row exactly as the Changes tab shows it: file icon, name, folder
 * and a colored status letter. Shared with the transcript's per-reply
 * "files changed" card so both surfaces look and behave the same.
 */
export function renderFileRow(file: ChangedFileSummary, selected: boolean, context: string, select: () => void): HTMLElement {
  const status = STATUS[file.status];
  return h("button", {
    class: `git-file-row status-${file.status}${selected ? " selected" : ""}`, type: "button", role: "option", title: fileRowTitle(file),
    aria: { selected: String(selected), label: `${file.path}, ${status.label}, ${context}` },
    data: { changePath: file.path }, onClick: select,
  }, ...fileRowContent(file.path), h("span", { class: "git-file-status", title: status.label }, status.letter));
}

interface ChangedFileSummary { readonly path: string; readonly status: ProjectChangeStatus; readonly previousPath?: string }

function fileRowTitle(file: ChangedFileSummary): string {
  return `${file.path} · ${STATUS[file.status].label}${file.previousPath === undefined ? "" : ` · from ${file.previousPath}`}`;
}

/** File icon, name and folder, shared by every file row. */
function fileRowContent(path: string): HTMLElement[] {
  const folder = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  return [icon("file-text"), h("span", { class: "git-file-name" }, basename(path)), h("span", { class: "git-file-directory" }, folder)];
}

/** Inputs for the shared numbered diff view. */
export interface FileDiffInput {
  readonly path: string;
  readonly status: ProjectChangeStatus;
  readonly rows: readonly DiffRow[];
  /** Where the diff comes from, for example "Working Tree" or "This reply". */
  readonly source: string;
  readonly previousPath?: string;
  readonly notice?: string;
  readonly split: boolean;
  readonly toggleSplit: () => void;
  readonly openFile: (path: string) => void;
  readonly close: () => void;
}

/** The selected file's diff, inline or split, as used by the Changes tab. */
export function renderFileDiff(input: FileDiffInput): HTMLElement {
  const { rows } = input;
  const diff = h("div", { class: "git-file-diff", aria: { label: `${input.path} diff` }, data: { diffPath: input.path } },
    h("div", { class: "git-diff-heading" }, h("span", { class: "git-diff-filename", title: input.path }, basename(input.path)),
      h("span", { class: "git-diff-source" }, input.source),
      h("button", { class: "icon-button", type: "button", aria: { label: "Toggle split diff", pressed: String(input.split) }, title: input.split ? "Show inline diff" : "Show split diff", onClick: input.toggleSplit }, icon("sidebar-simple")),
      h("button", { class: "icon-button", type: "button", title: "Open file", aria: { label: "Open changed file" }, disabled: input.status === "deleted", onClick: () => input.openFile(input.path) }, icon("arrow-up-right")),
      h("button", { class: "icon-button", type: "button", title: "Close diff", aria: { label: "Close diff" }, onClick: input.close }, icon("x"))),
    input.previousPath === undefined ? null : h("p", { class: "git-preview-note" }, `${input.previousPath} → ${input.path}`),
    input.notice === undefined ? null : h("p", { class: "git-preview-note" }, input.notice),
  );
  if (rows.length === 0) diff.append(h("p", { class: "git-empty" }, input.notice === undefined ? "No text differences in this file." : "Preview unavailable"));
  else if (input.split) {
    const aligned = splitDiffRows(rows);
    const panes = [true, false].map((old) => h("div", { class: "git-split-pane", data: { diffSide: old ? "old" : "current" } },
      ...aligned.map((row) => row.heading === undefined ? splitCell(old ? row.old : row.current, old) : h("div", { class: "git-diff-hunk" }, row.heading.text))));
    // Each half has its own horizontal viewport, keeping both versions
    // visible in a narrow panel. Vertical positions follow one another.
    let syncing = false;
    panes.forEach((pane, index) => pane.addEventListener("scroll", () => {
      if (syncing) return;
      const other = panes[1 - index]!;
      if (other.scrollTop !== pane.scrollTop) {
        syncing = true; other.scrollTop = pane.scrollTop; syncing = false;
      }
    }));
    diff.append(h("div", { class: "git-diff-scroll split", data: { diffLayout: "split" } }, ...panes));
  } else diff.append(h("div", { class: "git-diff-scroll", data: { diffLayout: "inline" } },
      ...rows.map((row) => row.kind === "hunk" || row.kind === "meta" ? h("div", { class: "git-diff-hunk" }, row.text)
        : h("div", { class: `git-diff-line ${row.kind}` }, h("span", { class: "git-line-number" }, row.oldLine ?? ""),
          h("span", { class: "git-line-number" }, row.newLine ?? ""), h("span", { class: "git-line-sign" }, row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "),
          h("span", { class: "git-line-text" }, row.text || " ")))),
  );
  return diff;
}

function splitCell(row: DiffRow | undefined, old: boolean): HTMLElement {
  return h("div", { class: `git-split-cell ${row?.kind ?? "empty"}` }, h("span", { class: "git-line-number" }, (old ? row?.oldLine : row?.newLine) ?? ""),
    h("span", { class: "git-line-text" }, row?.text || " "));
}
