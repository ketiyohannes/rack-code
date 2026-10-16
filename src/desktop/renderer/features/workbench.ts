/**
 * Right panel: a launcher of surfaces ("Open a surface"), and the open
 * surface itself.
 *
 * - The launcher lists the core Changes surface and every plugin surface
 *   enabled in Settings > Plugins, each with its single-key shortcut. While
 *   the launcher is visible and focus is not in a text field, pressing a
 *   surface's key opens it.
 * - Changes reads the selected project working tree through the controller.
 *   Polls are serialized, bounded by the host adapter, and paused while hidden.
 *   Stale replies cannot cross projects.
 * - Timeline (optional plugin) is a persistent panel owned by
 *   `timeline-panel.ts`; the workbench only attaches it and reports whether
 *   it is the open surface. Files, Terminal and Browser own persistent
 *   interactive panels; unfinished plugin surfaces remain previews.
 *
 * The open surface is local presentation state. If its plugin is disabled
 * while open, the panel returns to the launcher.
 */
import type { ProjectChanges, ProjectRepositories, RepositoryDiscoveryOptions } from "../../../contracts/desktop/index.js";
import { createDropdown } from "../components/dropdown.js";
import type { Controller } from "../controller.js";
import { renderRepositoryChanges, type ChangesMemory } from "./changes-view.js";
import { openPopover } from "../components/popover.js";
import { renderRunDetails } from "./run-detail.js";
import { createTimelinePanel } from "./timeline-panel.js";
import { createFilesPanel } from "./files-panel.js";
import { createTerminalPanel } from "./terminal-panel.js";
import { createBrowserPanel } from "./browser-panel.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import type { Store } from "../store.js";
import { SURFACES, type SurfaceDefinition } from "../surfaces.js";

export function mountWorkbench(root: HTMLElement, store: Store, isVisible: () => boolean, controller: Controller): void {
  let openSurface: string | undefined = "changes";
  let projectId: string | undefined;
  let repositories: ProjectRepositories | undefined;
  // Empty selection means All repositories; undefined means discovery pending.
  let repository: string | undefined;
  let generation = 0;
  let discoveryOptions: RepositoryDiscoveryOptions = {};
  const snapshots = new Map<string, { snapshot?: ProjectChanges; error?: string }>();
  let error: string | undefined;
  let inFlight = false;
  const changesMemory: ChangesMemory = { selectedFiles: new Map(), collapsedGroups: new Set(), split: false };
  // Changes and run details are rebuilt on render, so pickers are created
  // once and re-attached with fresh options; rebuilding them would close an open menu
  // whenever a streaming run re-renders the panel. App dropdowns replace
  // native <select> elements here, as everywhere in the renderer.
  const runPicker = createDropdown<string>({
    ariaLabel: "Run details for", menuWidth: 300,
    onChange: (runId) => { if (runId !== store.get().selection.runId) void controller.selectRun(runId); },
  });
  const repositoryPicker = createDropdown<string>({
    ariaLabel: "Repository", variant: "pill", menuWidth: 260,
    onChange: (value) => chooseRepository(value === ALL_REPOSITORIES ? "" : value),
  });
  const body = h("div", { class: "workbench-body" });
  root.append(body);
  // Created once so its search field and expansion state survive re-renders.
  const timelinePanel = createTimelinePanel(store, controller, isVisible);
  const filesPanel = createFilesPanel(store, controller, isVisible);
  const terminalPanel = createTerminalPanel(store, controller, isVisible);
  const browserPanel = createBrowserPanel(store, controller, isVisible);

  const available = (): readonly SurfaceDefinition[] => {
    const enabled = new Set(store.get().enabledPlugins);
    return SURFACES.filter((surface) => surface.kind === "core" || enabled.has(surface.id));
  };

  const open = (surfaceId: string | undefined) => {
    openSurface = surfaceId;
    render();
    void refresh();
    if (surfaceId === "run-details") {
      const run = selectedRun();
      if (run !== undefined && run.id !== store.get().selection.runId) void controller.selectRun(run.id);
    }
  };

  function render(): void {
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    // Persistent inputs (the Timeline filter) lose focus and caret when the
    // surface is re-attached; remember them so typing is not interrupted.
    const caret = focused instanceof HTMLInputElement ? { start: focused.selectionStart, end: focused.selectionEnd } : undefined;
    const focusPath = focused?.dataset["changePath"];
    const focusGroup = focused?.dataset["changeGroup"];
    const focusLabel = focused?.getAttribute("aria-label");
    const focusRepository = focused?.closest<HTMLElement>(".git-repository")?.dataset["repositoryKey"];
    const scroll = body.scrollTop;
    const diffScroll = [...body.querySelectorAll<HTMLElement>(".git-diff-scroll:not(.split), .git-split-pane")].map((node) => ({
      repository: node.closest<HTMLElement>(".git-repository")?.dataset["repositoryKey"], top: node.scrollTop, left: node.scrollLeft,
      path: node.closest<HTMLElement>(".git-file-diff")?.dataset["diffPath"], side: node.dataset["diffSide"],
    }));
    const surfaces = available();
    const surface = surfaces.find((candidate) => candidate.id === openSurface);
    // Streaming chat updates must not detach persistent editors, xterm's
    // hidden textarea, or the browser chrome. Reattachment loses focus and
    // IME composition even if the exact DOM node is inserted again.
    const persistent = surface?.id === "files" ? filesPanel.element
      : surface?.id === "terminal" ? terminalPanel.element
        : surface?.id === "browser" ? browserPanel.element
          : surface?.id === "timeline" ? timelinePanel.element : undefined;
    if (surface === undefined) {
      openSurface = undefined;
      replace(body, renderLauncher(surfaces, open));
    } else if (persistent === undefined || !body.contains(persistent)) {
      replace(body, renderSurface(surface, () => open(undefined), surface.id === "changes" ? renderChanges()
        : surface.id === "run-details" ? renderDetails()
          : surface.id === "timeline" ? timelinePanel.element
            : surface.id === "files" ? filesPanel.element
              : surface.id === "terminal" ? terminalPanel.element
                : surface.id === "browser" ? browserPanel.element : undefined));
    }
    timelinePanel.setActive(store.get().page === "chat" && surface?.id === "timeline");
    filesPanel.setActive(store.get().page === "chat" && surface?.id === "files");
    terminalPanel.setActive(store.get().page === "chat" && surface?.id === "terminal");
    browserPanel.setActive(store.get().page === "chat" && surface?.id === "browser");
    if (focused instanceof HTMLInputElement && focused.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
      if (caret !== undefined && caret.start !== null && caret.end !== null) focused.setSelectionRange(caret.start, caret.end);
    }
    body.scrollTop = scroll;
    for (const node of body.querySelectorAll<HTMLElement>(".git-diff-scroll:not(.split), .git-split-pane")) {
      const matches = diffScroll.filter((entry) => entry.repository === node.closest<HTMLElement>(".git-repository")?.dataset["repositoryKey"]
        && entry.path === node.closest<HTMLElement>(".git-file-diff")?.dataset["diffPath"]);
      const position = matches.find((entry) => entry.side === node.dataset["diffSide"]) ?? matches[0];
      if (position !== undefined) { node.scrollTop = position.top; node.scrollLeft = position.left; }
    }
    // A status poll or file selection rebuilds this surface. Keep keyboard
    // navigation on the same file/action without injecting paths into selectors.
    if (focused !== undefined) [...body.querySelectorAll<HTMLElement>("button")].find((node) =>
      node.closest<HTMLElement>(".git-repository")?.dataset["repositoryKey"] === focusRepository &&
      (focusPath !== undefined ? node.dataset["changePath"] === focusPath && node.dataset["changeGroup"] === focusGroup
        : focusLabel !== null && focusLabel !== undefined && node.getAttribute("aria-label") === focusLabel))?.focus({ preventScroll: true });
  }

  function sessionRuns() {
    const state = store.get();
    const runs = new Map(state.runs.map((run) => [run.id, run]));
    for (const live of Object.values(state.live)) {
      if (live.run.sessionId === state.selection.sessionId) runs.set(live.run.id, live.run);
    }
    return [...runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  function selectedRun() {
    const runs = sessionRuns();
    return runs.find((run) => run.id === store.get().selection.runId) ?? runs[0];
  }

  /** Diagnostics move to the side panel, keeping the chat footer quiet. */
  function renderDetails(): HTMLElement {
    const run = selectedRun();
    return h("div", { class: "changes-content" }, run === undefined ? h("p", { class: "note" }, "No runs in this session yet.")
      : h("div", {}, (() => {
        runPicker.setOptions(sessionRuns().map((candidate) => ({
          value: candidate.id, label: candidate.prompt.slice(0, 60) || "Run", description: candidate.status,
        })), run.id);
        return runPicker.element;
      })(),
        renderRunDetails(run, store.get(), controller)));
  }

  function saveSelection(): void {
    if (projectId === undefined || repository === undefined) return;
    try { localStorage.setItem(`changes.repository.${projectId}`, repository); } catch { /* Optional local preference. */ }
  }

  function chooseRepository(value: string): void {
    repository = value;
    generation++;
    snapshots.clear();
    changesMemory.collapsedGroups.clear();
    changesMemory.selectedFiles.clear();
    saveSelection();
    render();
    void refresh();
  }

  function rescan(options: RepositoryDiscoveryOptions = {}): void {
    discoveryOptions = { deep: discoveryOptions.deep === true, ...options, rescan: true };
    repositories = undefined;
    repository = undefined;
    snapshots.clear();
    error = undefined;
    generation++;
    render();
    void refresh();
  }

  async function chooseFolder(): Promise<void> {
    const selected = projectId;
    const project = store.get().projects.find((candidate) => candidate.id === selected);
    const path = await controller.selectDirectory("Choose a repository folder inside this workspace", project?.path);
    if (path !== undefined && selected === projectId) rescan({ repositoryPath: path });
  }

  /** Serialize reads and invalidate replies on either workspace or repository changes. */
  async function refresh(): Promise<void> {
    const state = store.get();
    // Read the project this panel's repository state belongs to, never the
    // live selection directly: store watchers are batched to animation
    // frames (which pause while the window is hidden), so the selection can
    // change before the watcher below resets `repositories`. Mixing the new
    // project with the old repository paths read the wrong folder. When they
    // differ, wait; the watcher resets the panel and refreshes.
    const selected = projectId;
    if (inFlight || openSurface !== "changes" || !isVisible() || state.host.status !== "ready" || selected === undefined
      || selected !== state.selection.projectId) return;
    inFlight = true;
    const version = generation;
    const current = () => generation === version && projectId === selected && store.get().selection.projectId === selected;
    try {
      if (repositories === undefined) {
        let found = await controller.discoverProjectRepositories(selected, discoveryOptions);
        if (!current()) return;
        let saved: string | null = null;
        try { saved = localStorage.getItem(`changes.repository.${selected}`); } catch { /* Use discovery order. */ }
        // Manually selected/deep repositories may not be in the shallow scan
        // after restarting. Revalidate that preference through the host.
        if (found.selectedPath === undefined && saved && !found.paths.includes(saved)) {
          try { found = await controller.discoverProjectRepositories(selected, { repositoryPath: saved }); }
          catch { found = { ...found, warnings: [...found.warnings, "The previous repository is unavailable. Choose another repository."] }; }
          if (!current()) return;
        }
        repositories = found;
        repository = found.selectedPath ?? (saved === "" ? "" : saved && found.paths.includes(saved) ? saved : found.paths[0]);
        discoveryOptions = { deep: discoveryOptions.deep === true };
        error = undefined;
        saveSelection();
        render();
      }
      const paths = repository === "" ? repositories.paths : repository === undefined ? [] : [repository];
      // A failed repository does not hide successful siblings in All repositories.
      for (const path of paths) {
        let result: { snapshot?: ProjectChanges; error?: string };
        try { result = { snapshot: await controller.getProjectChanges(selected, path) }; }
        catch (failure) { result = { error: failure instanceof Error ? failure.message : String(failure) }; }
        if (!current()) return;
        if (JSON.stringify(snapshots.get(path)) !== JSON.stringify(result)) {
          snapshots.set(path, result);
          render();
        }
      }
    } catch (failure) {
      if (!current()) return;
      error = failure instanceof Error ? failure.message : String(failure);
      render();
    } finally {
      inFlight = false;
      // A picker change during an old read should start immediately, not wait
      // for the next polling tick. Never run concurrent Git reads for this view.
      if (!current()) void refresh();
    }
  }

  function renderChanges(): HTMLElement {
    const project = store.get().projects.find((candidate) => candidate.id === projectId);
    const paths = repository === "" ? repositories?.paths ?? [] : repository === undefined ? [] : [repository];
    const actions = h("button", { class: "icon-button", type: "button", title: "Repository options", aria: { label: "Repository options", haspopup: "menu" }, onClick: () => {
      const menu = h("div", { class: "menu", role: "menu" });
      const choices = [
        { label: "Rescan repositories", action: () => rescan() },
        { label: "Scan deeper", action: () => rescan({ deep: true }) },
        { label: "Choose repository folder", action: () => void chooseFolder() },
      ];
      const popover = openPopover({ anchor: actions, content: menu, minWidth: 210, align: "end" });
      const items = choices.map((choice) => h("button", { class: "menu-item", type: "button", role: "menuitem", onClick: () => {
        popover.close(); actions.focus(); choice.action();
      } }, choice.label));
      menu.append(...items);
      popover.reposition(); items[0]?.focus();
      menu.addEventListener("keydown", (event) => {
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        } else if (event.key === "Tab") { actions.focus(); popover.close(); }
      });
    } }, icon("dots-three"));
    return h("div", { class: "git-changes-content" },
      h("div", { class: "changes-heading" },
        h("span", { class: "git-workspace-name", title: project?.path ?? "" }, project?.path.split("/").at(-1) ?? "Select a project"),
        h("button", { class: "icon-button", type: "button", title: "Refresh changes", aria: { label: "Refresh changes" }, onClick: () => void refresh() }, icon("arrow-clockwise")),
        projectId === undefined ? null : actions),
      (repositories?.paths.length ?? 0) > 1 ? h("div", { class: "git-repository-picker" }, (() => {
          repositoryPicker.setOptions([
            { value: ALL_REPOSITORIES, label: "All repositories", icon: "files" },
            ...(repositories?.paths ?? []).map((path) => ({ value: path, label: path === "." ? "Project repository" : path, icon: "git-diff" as const })),
          ], repository === "" ? ALL_REPOSITORIES : repository);
          return repositoryPicker.element;
        })()) : null,
      error !== undefined ? h("p", { class: "error-line" }, error)
        : projectId === undefined ? h("p", { class: "note" }, "Open a session to see its project changes.")
        : repositories === undefined ? h("p", { class: "note" }, "Finding repositories…")
        : repositories.paths.length === 0 ? h("p", { class: "note" }, "No repositories found. Scan deeper or choose a folder inside this project.") : null,
      repositories?.limited ? h("p", { class: "note" }, "Discovery reached its scan limit. Scan deeper or choose a repository folder.") : null,
      ...(repositories?.warnings ?? []).map((warning) => h("p", { class: "note" }, warning)),
      ...paths.map((path) => renderRepository(path)),
    );
  }

  function renderRepository(path: string): HTMLElement {
    const result = snapshots.get(path);
    const project = store.get().projects.find((candidate) => candidate.id === projectId);
    return renderRepositoryChanges({
      key: `${projectId}:${path}`, label: path === "." ? project?.path.split("/").at(-1) ?? "Repository" : path,
      ...(result?.snapshot === undefined ? {} : { snapshot: result.snapshot }), ...(result?.error === undefined ? {} : { error: result.error }),
      memory: changesMemory, redraw: render, openFile: (filePath) => {
        if (project !== undefined) void controller.openPath(filePath, path === "." ? project.path : `${project.path}/${path}`);
      },
    });
  }

  // Poll current filesystem changes even when a tool produces no native diff.
  // Refresh also follows project selection and run start/finish, independently
  // of chat deltas, so streaming text never starts a Git process per token.
  const interval = window.setInterval(() => void refresh(), 2000);
  // Hidden windows throttle timers; catch up as soon as the window is shown.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  window.addEventListener("unload", () => window.clearInterval(interval), { once: true });
  store.watch((state) => [state.selection.projectId, state.host.status, state.runs, Object.keys(state.live).join("|")], () => {
    const selected = store.get().selection.projectId;
    if (selected !== projectId) {
      projectId = selected;
      repositories = undefined;
      repository = undefined;
      discoveryOptions = {};
      generation++;
      snapshots.clear();
      error = undefined;
      changesMemory.collapsedGroups.clear();
      changesMemory.selectedFiles.clear();
      render();
    }
    void refresh();
  });

  // Single-key shortcuts while the launcher is showing.
  document.addEventListener("keydown", (event) => {
    if (openSurface !== undefined || !isVisible() || event.metaKey || event.ctrlKey || event.altKey) return;
    if (store.get().settings.open || isTextInput(event.target)) return;
    const match = available().find((surface) => surface.shortcut.toLowerCase() === event.key.toLowerCase());
    if (match !== undefined) {
      event.preventDefault();
      open(match.id);
    }
  });

  store.watch((state) => [state.enabledPlugins, state.page], () => { render(); void refresh(); });
  store.watch((state) => [state.selection.runId, state.journal, state.live, state.runs, state.session], () => {
    if (openSurface === "run-details") render();
  });
}

/** Picker value for "All repositories"; the panel stores it as "". */
const ALL_REPOSITORIES = "__all__";

function renderLauncher(surfaces: readonly SurfaceDefinition[], open: (id: string) => void): HTMLElement {
  return h("div", { class: "launcher" },
    h("p", { class: "launcher-title" }, "Open a surface"),
    h("div", { class: "launcher-list" },
      ...surfaces.map((surface) => h("button", {
        class: "launcher-item",
        type: "button",
        title: surface.description,
        onClick: () => open(surface.id),
      },
        icon(surface.icon),
        h("span", { class: "launcher-label" }, surface.title),
        h("kbd", { class: "key-hint" }, surface.shortcut),
      )),
    ),
    h("p", { class: "launcher-note" }, "Enable more surfaces in Settings > Plugins."),
  );
}

function renderSurface(surface: SurfaceDefinition, back: () => void, content?: HTMLElement): HTMLElement {
  return h("div", { class: "surface", data: { surface: surface.id } },
    h("div", { class: "surface-header" },
      h("button", { class: "icon-button", type: "button", title: "All surfaces", aria: { label: "All surfaces" }, onClick: back }, icon("arrow-left")),
      icon(surface.icon),
      h("span", { class: "surface-title" }, surface.title),
      surface.preview ? h("span", { class: "soon" }, "Preview") : null,
    ),
    content ?? h("div", { class: "placeholder" },
      h("span", { class: "placeholder-icon" }, icon(surface.icon)),
      h("p", { class: "placeholder-title" }, surface.kind === "core" ? "No changes yet" : `${surface.title} is not available yet`),
      h("p", { class: "placeholder-text" }, surface.kind === "core"
        ? "Code changes and diffs from runs will appear here."
        : `${surface.description} This plugin is a preview with no functionality yet.`),
    ),
  );
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}
