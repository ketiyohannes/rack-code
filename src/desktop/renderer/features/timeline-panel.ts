import { createDropdown } from "../components/dropdown.js";
import { openModal } from "../components/modal.js";
/**
 * Timeline surface: the selected project's history, either along the current
 * branch or across every local and remote-tracking branch.
 *
 * Presentation only. Capability, capture, filtering, and diff generation are
 * host behavior (`features/timeline`); this module requests them through the
 * controller and renders the results.
 *
 * History opens without recording opt-in or a selected session. The former
 * per-session recorder view ("This session") was removed from the panel on
 * 2026-10-21; the host still records and serves session checkpoints for
 * compatibility, but Timeline is now a single project-level history. Git
 * operations (stage, commit, push, merge) live in the Changes panel.
 *
 * Each checkpoint shows its label, file count and relative time on one line,
 * with provenance in its tooltip, a collapsible visible file tree, and a diff
 * preview of the selected file (the first file by default) limited to 16
 * rendered rows, expandable to the full bounded patch. The newest matching
 * checkpoint is open unless the user explicitly toggled it. The list is
 * newest first, so the latest observation is at the top of the side panel.
 *
 * Search is a case-insensitive substring match over the checkpoint number,
 * label, and changed paths. It filters the loaded list and never searches
 * file contents.
 *
 * Freshness: the panel reloads on project/view changes, on becoming
 * visible, and on relevant `timeline.changed` events. Project history also
 * polls external Git changes every four seconds while open. Loads are
 * serialized; changes during a load coalesce. Generation checks discard
 * replies for previous query identities and then load the current one.
 *
 * The panel element is created once and re-attached by the workbench on
 * every render, so the search field keeps its value (and focus, which the
 * workbench restores) while runs stream.
 */
import type {
  ProjectBranches,
  ProjectBranch,
  ProjectRepositories,
  TimelineChangedPath,
  TimelineCheckpointEntry,
  TimelineFileDiff,
  TimelineProjectHistory,
  TimelineProjectHistoryEntry,
} from "../../../contracts/desktop/index.js";
import type { Controller } from "../controller.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon } from "../icons.js";
import type { Store } from "../store.js";
import { diffRows, type DiffRow } from "./change-diff.js";
import { buildTree, type TreeFolder } from "./timeline-tree.js";

/** Rendered rows in a collapsed preview (specification section 9). */
export const PREVIEW_ROWS = 16;
/** Cached file diffs; checkpoints are immutable, so entries never go stale. */
const DIFF_CACHE_LIMIT = 40;
type HistoryEntry = TimelineCheckpointEntry | TimelineProjectHistoryEntry;

const STATUS_LETTER: Record<TimelineChangedPath["status"], { readonly letter: string; readonly label: string }> = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  type_changed: { letter: "T", label: "Type changed" },
};

export interface TimelinePanel {
  readonly element: HTMLElement;
  /** Tells the panel whether it is the open surface; becoming active reloads. */
  setActive(active: boolean): void;
}

interface DiffState {
  readonly promise: Promise<TimelineFileDiff>;
  result?: TimelineFileDiff;
  error?: string;
}

export function createTimelinePanel(store: Store, controller: Controller, isVisible: () => boolean): TimelinePanel {
  let active = false;
  let projectId: string | undefined;
  // Timeline can browse a nested repository without navigating away from
  // the selected chat. Actual chat project changes reset this local choice.
  let selectedProjectId: string | undefined;
  // "project" follows HEAD's first-parent history; "global" spans all branches.
  let scope: "project" | "global" = "project";
  let projectHistory: TimelineProjectHistory | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let checkpoints: readonly HistoryEntry[] = [];
  let loadError: string | undefined;
  let actionError: string | undefined;
  let changing = false;
  let inFlight = false;
  let stale = true;
  let query = "";
  let repositories: ProjectRepositories | undefined;
  let repositoryError: string | undefined;
  let discovering = false;
  let openingRepository = false;
  let repositoryNoticeKey: string | undefined;
  // Explicit user choices only; absent means "use the default".
  const expansion = new Map<string, boolean>();
  const collapsedFolders = new Map<string, Set<string>>();
  const selectedFiles = new Map<string, string>();
  const fullPreviews = new Set<string>();
  const diffs = new Map<string, DiffState>();

  const search = h("input", {
    class: "timeline-search", type: "search", placeholder: "Filter recorded changes",
    aria: { label: "Filter recorded changes" },
    onInput: () => { query = search.value; renderList(); },
  });
  // Pauses or resumes project recording; the label follows the current state.
  const disable = h("button", {
    class: "icon-button", type: "button", title: "Pause project recording. History is kept.", aria: { label: "Pause project recording. History is kept." },
    onClick: () => void setProjectRecording(),
  }, icon("pause"));
  const projectTab = h("button", {
    type: "button", role: "tab", onClick: () => changeScope("project"),
  }, "Current branch");
  const globalTab = h("button", { type: "button", role: "tab", onClick: () => changeScope("global") }, "All branches");
  const refresh = h("button", {
    class: "icon-button", type: "button", title: "Refresh timeline", aria: { label: "Refresh timeline" },
    onClick: () => void load(),
  }, icon("arrow-clockwise"));
  const tabs = h("div", { class: "timeline-scopes" },
    h("div", { role: "tablist", aria: { label: "Timeline scope" } }, projectTab, globalTab), refresh);
  const controls = h("div", { class: "timeline-controls" }, search, disable);
  tabs.append(h("button", { class: "icon-button", type: "button", title: "Pull requests", aria: { label: "Pull requests" }, onClick: () => controller.openPage("pull-requests", projectId) }, icon("git-pull-request")));
  const notices = h("div", { class: "timeline-notices" });
  const list = h("div", { class: "timeline-list", role: "list", aria: { label: "Recorded changes" } });
  const repositoryName = h("span", { class: "timeline-repository-name" });
  const repositoryContext = h("div", { class: "timeline-repository-context" }, repositoryName,
    h("button", { class: "icon-button", type: "button", title: "Back to project", aria: { label: "Back to project" }, onClick: () => {
      projectId = selectedProjectId;
      reset(); render(); void load();
    } }, icon("arrow-left")));
  let branches: ProjectBranches | undefined;
  let branchError: string | undefined;
  const branchPicker = createDropdown<string>({ ariaLabel: "Checkout project branch", variant: "pill", icon: "git-branch", placeholder: "Choose branch", menuWidth: 300,
    onChange: ref => { const branch = branches?.branches.find(b => b.ref === ref); if (branch) confirmCheckout(branch); } });
  const branchContext = h("span", { class: "note timeline-checkout-context" });
  const branchControls = h("div", { class: "timeline-branch-controls" }, branchPicker.element, branchContext);
  const element = h("div", { class: "git-changes-content timeline-content" }, repositoryContext, tabs, branchControls, controls, notices, list);

  /** Drop state whenever the query identity changes, including during a load. */
  function reset(): void {
    generation++;
    element.scrollTop = 0;
    projectHistory = undefined; branches = undefined; branchError = undefined;
    checkpoints = [];
    loadError = undefined;
    actionError = undefined;
    repositories = undefined;
    repositoryError = undefined;
    discovering = false;
    openingRepository = false;
    repositoryNoticeKey = undefined;
    stale = true;
    query = "";
    search.value = "";
    expansion.clear();
    collapsedFolders.clear();
    selectedFiles.clear();
    fullPreviews.clear();
    diffs.clear();
  }

  function changeScope(next: typeof scope): void {
    if (scope === next) return;
    scope = next;
    reset();
    render();
    void load();
  }

  /** True while a run edits the viewed project; the host enforces this too. */
  function busy(): boolean {
    return Object.values(store.get().live).some((live) => live.run.projectId === projectId);
  }

  async function load(): Promise<void> {
    const selected = projectId;
    if (selected === undefined || !active || !isVisible() || document.visibilityState === "hidden" || store.get().host.status !== "ready") return;
    if (inFlight) { stale = true; return; }
    inFlight = true;
    stale = false;
    const version = generation;
    try {
      const [result, catalog] = await Promise.all([
        controller.timelineProjectHistory(selected, scope === "global" ? "all" : "current"),
        controller.projectBranches(selected).then(value => ({ value })).catch(error => ({ error: error instanceof Error ? error.message : String(error) })),
      ]);
      if (version === generation) {
        projectHistory = result; checkpoints = result.checkpoints; loadError = undefined;
        branches = "value" in catalog ? catalog.value : undefined; branchError = "error" in catalog ? catalog.error : undefined;
        if (!result.supported && repositories === undefined && !discovering) void discoverRepositories();
      }
    } catch (error) {
      if (version === generation) loadError = error instanceof Error ? error.message : String(error);
    } finally {
      inFlight = false;
    }
    render();
    if (stale || version !== generation) void load();
  }

  /** Reuse Projects' bounded discovery; stale replies cannot cross folders/scopes. */
  async function discoverRepositories(deep = false): Promise<void> {
    const selected = projectId;
    if (selected === undefined || discovering) return;
    const version = generation;
    discovering = true;
    repositoryError = undefined;
    render();
    try {
      const result = await controller.discoverProjectRepositories(selected, deep ? { rescan: true, deep: true } : {});
      if (version === generation) repositories = result;
    } catch (error) {
      if (version === generation) repositoryError = error instanceof Error ? error.message : String(error);
    } finally {
      if (version === generation) { discovering = false; render(); }
    }
  }

  /** Discovered folders use normal project identity/tracking, but selecting
   * one changes only this panel's query. The chat keeps its session/project.
   */
  async function openRepository(relativePath: string): Promise<void> {
    const project = store.get().projects.find((candidate) => candidate.id === projectId);
    if (project === undefined || openingRepository || !repositories?.paths.includes(relativePath)) return;
    const version = generation;
    const path = relativePath === "." ? project.path : `${project.path.replace(/[\\/]+$/, "")}/${relativePath}`;
    openingRepository = true;
    repositoryError = undefined;
    render();
    try {
      const target = store.get().projects.find((candidate) => candidate.path === path)
        ?? await controller.registerProject({ path });
      if (version !== generation) return;
      if (target === undefined) { repositoryError = "Could not open this repository. Try again."; return; }
      projectId = target.id;
      reset();
      render();
      void load();
    } catch (error) {
      if (version === generation) repositoryError = error instanceof Error ? error.message : String(error);
    } finally {
      if (version === generation) { openingRepository = false; render(); }
    }
  }

  function renderRepositoryChooser(): HTMLElement {
    return h("section", { class: "timeline-repositories", aria: { label: "Choose a repository" } },
      h("h3", {}, "Choose a repository"),
      h("p", {}, "Choose a repository to view its Timeline alongside this session."),
      h("div", { class: "timeline-repository-list" },
        ...(repositories?.paths ?? []).map((path) => h("button", {
          class: "timeline-repository-choice", type: "button", disabled: openingRepository,
          title: path, aria: { label: `Open repository ${path}` }, onClick: () => void openRepository(path),
        }, icon("folder-open"), h("span", {}, path), icon("arrow-right"))),
      ),
      discovering ? note("Finding repository folders…") : null,
      !discovering && repositories?.paths.length === 0 ? note("No repository folders found. Try a deeper scan.") : null,
      repositories?.limited ? note("More repositories may exist outside this scan. Scan deeper to find them.") : null,
      ...(repositories?.warnings ?? []).map((warning) => note(warning)),
      repositoryError === undefined ? null : h("p", { class: "error-line timeline-note", role: "alert" }, repositoryError),
      h("button", { class: "button button-small", type: "button", disabled: discovering || openingRepository,
        onClick: () => void discoverRepositories(true) }, "Scan deeper"),
    );
  }

  async function setProjectRecording(): Promise<void> {
    if (projectId === undefined || changing) return;
    const version = generation;
    changing = true;
    actionError = undefined;
    render();
    try {
      const result = await controller.setProjectTimelineEnabled(projectId, !projectHistory?.recording);
      if (version === generation) { projectHistory = result; if (scope !== "global") checkpoints = result.checkpoints; }
    } catch (error) {
      if (version === generation) actionError = error instanceof Error ? error.message : String(error);
    } finally { changing = false; }
    if (version === generation) { render(); void load(); }
  }

  function confirmCheckout(branch: ProjectBranch): void {
    const selected = projectId, catalog = branches, version = generation;
    if (!selected || !catalog?.head || changing) return;
    const confirm = h("button", { class: "button button-primary button-small", type: "button", disabled: catalog.dirty || busy(), onClick: () => {
      modal.close(); void checkout(selected, branch.ref, catalog.head!, version);
    } }, icon("git-branch"), "Checkout branch");
    const modal = openModal({ title: `Checkout ${branch.name}?`, onClose: () => { if (version === generation) render(); }, content: h("div", { class: "modal-body" },
      h("p", {}, "Switch the project checkout to this branch. Isolated session worktrees keep their own branches."),
      h("code", { class: "timeline-checkout-path" }, catalog.repositoryRoot),
      h("p", { class: "note" }, catalog.dirty ? "Commit or stash uncommitted changes before switching." : branch.kind === "remote" ? "Creates a local tracking branch. No fetch is performed." : "Updates the checkout's files and HEAD; no changes are discarded."),
      h("div", { class: "modal-actions" }, h("button", { class: "button button-small", onClick: () => modal.close() }, "Cancel"), confirm)) });
  }

  async function checkout(selected: string, ref: string, head: string, version: number): Promise<void> {
    if (version !== generation || changing) return;
    changing = true; actionError = undefined; render();
    try { const result = await controller.checkoutProjectBranch(selected, ref, head); if (version === generation) branches = result; }
    catch (error) { if (version === generation) actionError = error instanceof Error ? error.message : String(error); }
    finally { changing = false; }
    if (version === generation) { render(); void load(); }
  }

  function render(): void {
    const state = store.get();
    repositoryContext.hidden = projectId === selectedProjectId;
    const viewed = state.projects.find((project) => project.id === projectId);
    repositoryName.textContent = viewed?.path.split(/[\\/]/).at(-1) ?? "Repository";
    repositoryName.title = viewed?.path ?? "";
    const enabled = projectHistory?.supported === true;
    tabs.hidden = projectId === undefined;
    projectTab.setAttribute("aria-selected", String(scope === "project"));
    globalTab.setAttribute("aria-selected", String(scope === "global"));
    // Native tab semantics: arrows move between the two views.
    projectTab.tabIndex = scope === "project" ? 0 : -1;
    globalTab.tabIndex = scope === "global" ? 0 : -1;
    replace(disable, icon(projectHistory?.recording ? "pause" : "play"));
    disable.title = `${projectHistory?.recording ? "Pause" : "Resume"} project recording. History is kept.`;
    disable.setAttribute("aria-label", disable.title);
    controls.hidden = !enabled;
    disable.disabled = changing;
    // Polling must not detach focused folder buttons when the discovery and
    // unsupported state are unchanged; keyboard users can browse the list.
    const chooserKey = projectHistory?.supported === false && loadError === undefined
      ? JSON.stringify([projectId, projectHistory.reason, repositories, repositoryError, discovering, openingRepository]) : undefined;
    if (chooserKey === undefined || chooserKey !== repositoryNoticeKey) {
      replace(notices, ...renderNotices(state.selection.projectId, enabled));
      repositoryNoticeKey = chooserKey;
    }
    branchControls.hidden = !projectHistory?.supported;
    branchPicker.setOptions((branches?.branches ?? []).map(b => ({ value: b.ref, label: b.name,
      group: b.kind === "local" ? "Local branches" : "Remote branches", icon: "git-branch" as const,
      description: b.worktreePath && b.name !== branches?.current ? `In use: ${b.worktreePath}` : b.commit.slice(0, 8),
      disabled: Boolean(b.worktreePath && b.name !== branches?.current) })), branches?.current ? `refs/heads/${branches.current}` : undefined);
    branchPicker.setValue(branches?.current ? `refs/heads/${branches.current}` : undefined);
    branchPicker.setDisabled(changing || busy() || !branches?.head);
    branchContext.textContent = branches ? `Project checkout${!branches.current && branches.head ? ` · detached ${branches.head.slice(0, 8)}` : ""}${branches.dirty ? " · uncommitted changes" : ""}` : branchError ?? "Loading branches…";
    branchContext.title = branches?.repositoryRoot ?? branchError ?? "";
    renderList();
  }

  function renderNotices(projectId: string | undefined, enabled: boolean): readonly HTMLElement[] {
    const lines: HTMLElement[] = [];
    if (projectId === undefined) return [note("Open a project to view its timeline.")];
    if (loadError !== undefined) return [h("p", { class: "error-line timeline-note" }, loadError)];
    if (projectHistory === undefined) return [note("Loading project history…")];
    if (!projectHistory.supported) return [note(projectHistory.reason ?? "Timeline is not supported for this project."), renderRepositoryChooser()];
    if (projectHistory.truncated) lines.push(note("Showing history from the 200 most recent commits and saved snapshots."));
    if (projectHistory.captureError !== undefined) lines.push(note(`Project changes could not be recorded: ${projectHistory.captureError}`, "warning-circle"));
    if (actionError !== undefined) lines.push(h("p", { class: "error-line timeline-note" }, actionError));
    if (enabled && checkpoints.length === 0) lines.push(note("No existing commits or recorded file changes in this project yet."));
    return lines;
  }

  function renderList(): void {
    const enabled = projectHistory?.supported === true;
    // The whole Timeline panel scrolls inside the clipped workbench surface.
    // Preserve its position when polling replaces the checkpoint list.
    const scroll = element.scrollTop;
    if (!enabled || checkpoints.length === 0) { replace(list); return; }
    const needle = query.trim().toLowerCase();
    const matching = checkpoints.filter((entry) => needle === "" ||
      `${entry.position} #${entry.position} ${entry.label} ${"branches" in entry ? entry.branches?.join(" ") : ""} ${entry.files.map((file) => file.path).join(" ")}`.toLowerCase().includes(needle));
    if (matching.length === 0) {
      replace(list, h("p", { class: "git-empty" }, "No matching recorded changes."));
      return;
    }
    const latest = matching.at(-1);
    replace(list, ...[...matching].reverse().map((entry) => renderCheckpoint(entry, entry === latest)));
    element.scrollTop = scroll;
  }

  function renderCheckpoint(entry: HistoryEntry, latest: boolean): HTMLElement {
    const open = expansion.get(entry.id) ?? latest;
    const count = entry.files.length;
    const date = new Date(entry.createdAt);
    const provenance = entry.source === "git" ? `Git commit ${"snapshot" in entry ? entry.snapshot.slice(0, 8) : ""}`
      : "sessionId" in entry ? `Session ${entry.sessionId}` : "Recorded change";
    // Keep the sidebar row compact. Provenance, branch tips and merge parents
    // remain in the tooltip while the title, count and time share one line.
    const branches = "branches" in entry ? entry.branches ?? [] : [];
    const parents = "parents" in entry ? entry.parents ?? [] : [];
    const tooltip = [entry.label, provenance, date.toLocaleString(),
      ...(branches.length ? [`Branches: ${branches.join(", ")}`] : []),
      ...(parents.length > 1 ? [`Merge compared with first parent; parents: ${parents.map(p => p.slice(0, 8)).join(", ")}`] : [])].join(" · ");
    const details = h("details", { class: "timeline-entry", open, data: { checkpointId: entry.id } },
      h("summary", { title: tooltip },
        icon("caret-right", { className: "activity-caret" }),
        h("span", { class: "timeline-label" }, entry.label),
        h("span", { class: "timeline-meta" }, h("span", {}, `${count} ${count === 1 ? "file" : "files"}`),
          h("time", { class: "timeline-time", title: date.toLocaleString() }, relativeTime(entry.createdAt))),
        openSnapshotButton(entry)),
    );
    if (open) details.append(...renderBody(entry));
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      expansion.set(entry.id, details.open);
      // Build the body lazily so closed checkpoints never request diffs.
      if (details.open && details.childElementCount === 1) details.append(...renderBody(entry));
    });
    return h("article", { class: "timeline-item", role: "listitem" }, details);
  }

  function renderBody(entry: HistoryEntry): readonly HTMLElement[] {
    const selected = entry.files.find((file) => file.path === selectedFiles.get(entry.id)) ?? entry.files[0];
    if (!selected) return [note("No visible file changes compared with the first parent.")];
    const preview = h("div", { class: "timeline-preview" });
    if (selected !== undefined) renderPreview(preview, entry, selected);
    return [renderTree(entry, selected?.path), preview];
  }

  /** Native viewer captures this scope/identity; later sidebar navigation is independent. */
  function openSnapshotButton(entry: HistoryEntry, path?: string): HTMLButtonElement {
    return h("button", {
      class: "icon-button timeline-expand", type: "button", title: "Open snapshot in a new window",
      aria: { label: path === undefined ? `Open snapshot: ${entry.label}` : `Open snapshot file: ${path}` },
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const contextId = projectId;
        if (contextId === undefined) return;
        const version = generation;
        void controller.openTimelineWindow({ scope: "project", contextId, checkpointId: entry.id,
          ...(path === undefined ? {} : { path }) }).catch((error: unknown) => {
          if (version !== generation) return;
          actionError = error instanceof Error ? error.message : String(error);
          render();
        });
      },
    }, icon("arrows-out-simple"));
  }

  function renderTree(entry: HistoryEntry, selectedPath: string | undefined): HTMLElement {
    const collapsed = collapsedFolders.get(entry.id) ?? new Set<string>();
    collapsedFolders.set(entry.id, collapsed);
    const tree = buildTree(entry.files);
    const container = h("div", { class: "timeline-tree", role: "tree", aria: { label: `Files changed in checkpoint ${entry.position}` } });
    const renderNode = (node: TreeFolder, depth: number): HTMLElement[] => {
      const rows: HTMLElement[] = [];
      for (const folder of node.folders) {
        const folderDetails = h("details", { class: "timeline-folder", open: !collapsed.has(folder.path) },
          indent(h("summary", { role: "treeitem", title: folder.path },
            icon("caret-right", { className: "activity-caret" }), icon("folder-simple"), h("span", { class: "git-file-name" }, folder.name)), depth),
          ...renderNode(folder, depth + 1));
        folderDetails.addEventListener("toggle", () => {
          if (!folderDetails.isConnected) return;
          if (folderDetails.open) collapsed.delete(folder.path); else collapsed.add(folder.path);
        });
        rows.push(folderDetails);
      }
      for (const file of node.files) {
        const meta = STATUS_LETTER[file.status];
        rows.push(indent(h("button", {
          class: `git-file-row status-${file.status}${file.path === selectedPath ? " selected" : ""}`, type: "button", role: "treeitem",
          title: `${file.path} · ${meta.label}`,
          aria: { selected: String(file.path === selectedPath), label: `${file.path}, ${meta.label}` },
          onClick: () => { selectedFiles.set(entry.id, file.path); renderList(); },
        }, icon("file-text"), h("span", { class: "git-file-name" }, basename(file.path)), h("span", { class: "git-file-directory" }),
          h("span", { class: "git-file-status", title: meta.label }, meta.letter)), depth));
      }
      return rows;
    };
    container.append(...renderNode(tree, 0));
    return container;
  }

  function renderPreview(container: HTMLElement, entry: HistoryEntry, file: TimelineChangedPath): void {
    const selected = projectId;
    if (selected === undefined) return;
    const key = `${selected}|${entry.id}|${file.path}`;
    let state = diffs.get(key);
    if (state === undefined) {
      const promise = controller.timelineProjectFileDiff(selected, entry.id, file.path);
      const created: DiffState = { promise };
      state = created;
      diffs.set(key, created);
      if (diffs.size > DIFF_CACHE_LIMIT) diffs.delete(diffs.keys().next().value!);
      promise.then((result) => { created.result = result; }, (error: unknown) => {
        created.error = error instanceof Error ? error.message : String(error);
        // Allow a later attempt, for example after Git becomes available.
        if (diffs.get(key) === created) diffs.delete(key);
      }).finally(() => { if (container.isConnected) renderPreview(container, entry, file); });
    }
    const heading = h("div", { class: "git-diff-heading" },
      h("span", { class: "git-diff-filename", title: file.path }, file.path),
      h("span", { class: "git-diff-source" }, STATUS_LETTER[file.status].label), openSnapshotButton(entry, file.path));
    if (state.error !== undefined) { replace(container, heading, h("p", { class: "error-line timeline-note" }, state.error)); return; }
    if (state.result === undefined) { replace(container, heading, h("p", { class: "git-empty" }, "Loading changes…")); return; }
    const result = state.result;
    const rows = diffRows(result.diff).filter((row) => row.kind !== "meta" || !row.text.startsWith("Binary "));
    if (result.notice !== undefined || rows.length === 0) {
      replace(container, heading, h("p", { class: "git-empty" }, result.notice ?? "No text changes in this file."));
      return;
    }
    const full = fullPreviews.has(key);
    const shown = full ? rows : rows.slice(0, PREVIEW_ROWS);
    replace(container, heading,
      h("div", { class: "git-diff-scroll timeline-diff", aria: { label: `Changes in ${file.path}` } }, ...shown.map(renderRow)),
      rows.length > PREVIEW_ROWS ? h("button", {
        class: "timeline-more", type: "button",
        onClick: () => { if (full) fullPreviews.delete(key); else fullPreviews.add(key); renderPreview(container, entry, file); },
      }, full ? "Show less" : `Show all ${rows.length} rows`) : null,
      result.truncated ? h("p", { class: "git-preview-note" }, "This diff was shortened for preview.") : null);
  }

  // Any recorded change, commit or checkout may alter project history.
  controller.onTimelineChanged(() => {
    if (active && isVisible()) void load(); else stale = true;
  });
  store.watch((state) => [state.selection.projectId, state.selection.sessionId, state.host.status], () => {
    const selection = store.get().selection;
    const projectChanged = selection.projectId !== selectedProjectId;
    selectedProjectId = selection.projectId;
    if (projectChanged) { projectId = selection.projectId; reset(); }
    render();
    if (stale) void load();
  });
  // Run start/finish changes whether settings can be toggled.
  store.watch((state) => Object.values(state.live).map((live) => `${live.run.id}:${live.run.status}`).join("|"), () => { if (active && !document.hidden) render(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && active) void load();
  });
  tabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const choices = [projectTab, globalTab];
    if (!choices.includes(event.target as HTMLButtonElement)) return;
    event.preventDefault();
    const index = choices.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : (index + 1) % 2;
    changeScope((["project", "global"] as const)[next]!);
    choices[next]?.focus();
  });

  return {
    element,
    setActive(next) {
      const becameActive = next && !active;
      active = next;
      if (poll !== undefined) { clearInterval(poll); poll = undefined; }
      // Poll external Git commits/ref changes only while the panel is open.
      if (active) poll = setInterval(() => { if (!document.hidden) void load(); }, 10_000);
      if (becameActive) { render(); void load(); }
    },
  };
}

function renderRow(row: DiffRow): HTMLElement {
  if (row.kind === "hunk" || row.kind === "meta") return h("div", { class: "git-diff-hunk" }, row.text);
  return h("div", { class: `git-diff-line ${row.kind}` },
    h("span", { class: "git-line-number" }, row.oldLine ?? ""),
    h("span", { class: "git-line-number" }, row.newLine ?? ""),
    h("span", { class: "git-line-sign" }, row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "),
    h("span", { class: "git-line-text" }, row.text || " "));
}

function note(text: string, iconName: "info" | "warning-circle" = "info"): HTMLElement {
  return h("p", { class: "note timeline-note" }, icon(iconName), h("span", {}, text));
}

/** Tree indentation through the CSSOM; the renderer CSP forbids style attributes. */
function indent<T extends HTMLElement>(element: T, depth: number): T {
  element.style.paddingLeft = `${12 + depth * 12}px`;
  return element;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
