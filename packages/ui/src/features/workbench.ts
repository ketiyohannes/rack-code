import { createOrchestraPanel } from "./orchestra-panel.js";
/**
 * Tabbed right workbench. Tool instances belong to their panels, so switching
 * or closing a tab preserves shell output, file drafts and the shared browser.
 * Each window starts with a blank tab containing the tool launcher. Adding an
 * optional tool enables its existing plugin through the controller; neither
 * saved plugin preferences nor earlier tabs pre-open tools on startup.
 */
import type { ProjectChanges, ProjectRepositories, RepositoryDiscoveryOptions } from "@rack/contracts";
import { createDropdown } from "../components/dropdown.js";
import type { Controller } from "../controller.js";
import { clearChangesMemory, createChangesMemory, renderRepositoryChanges } from "./changes-view.js";
import { openPopover, type PopoverHandle } from "../components/popover.js";
import { renderRunDetails } from "./run-detail.js";
import { createTimelinePanel } from "./timeline-panel.js";
import { createSideChat } from "./side-chat.js";
import { sessionSideChatContext } from "./side-chat-contexts.js";
import type { HostClient } from "@rack/client/host-client";
import { createFilesPanel } from "./files-panel.js";
import { createTerminalPanel } from "./terminal-panel.js";
import { createBrowserPanel } from "./browser-panel.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import type { Store } from "../store.js";
import { SURFACES, type SurfaceDefinition } from "../surfaces.js";

export function mountWorkbench(root: HTMLElement, store: Store, isVisible: () => boolean, controller: Controller, host: HostClient, onEmpty: () => void): void {
  let nextBlankId = 1;
  let tabs = ["new-tab-1"];
  let openSurface: string | undefined = tabs[0];
  let tabSignature = "";
  let projectId: string | undefined;
  // Isolated session whose worktree the panel reads; undefined reads the project folder.
  let viewSessionId: string | undefined;
  let repositories: ProjectRepositories | undefined;
  // Empty selection means All repositories; undefined means discovery pending.
  let repository: string | undefined;
  let generation = 0;
  let discoveryOptions: RepositoryDiscoveryOptions = {};
  const snapshots = new Map<string, { snapshot?: ProjectChanges; error?: string }>();
  let error: string | undefined;
  let inFlight = false;
  const surfaceScroll = new Map<string, number>();
  // Selections, collapsed groups, commit drafts and operation state survive
  // polling re-renders; they reset when the panel changes folders.
  const changesMemory = createChangesMemory();
  /** Set when an operation finishes during a read; that read's completion reads again. */
  let rereadRequested = false;
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
  const tabList = h("div", { class: "workbench-tabs", role: "tablist", aria: { label: "Workbench tools" } });
  let toolMenu: PopoverHandle | undefined;
  const addTab = h("button", { class: "icon-button workbench-add-tab", type: "button", title: "Add tool tab", aria: { label: "Add tool tab", haspopup: "menu", expanded: "false" }, onClick: () => {
    if (toolMenu) { toolMenu.close(); return; }
    const menu = h("div", { class: "menu workbench-tool-menu", role: "menu", aria: { label: "Add a tool tab" } });
    const picker = openPopover({ anchor: addTab, content: menu, minWidth: 220, align: "end", onClose: () => { toolMenu = undefined; addTab.setAttribute("aria-expanded", "false"); } });
    toolMenu = picker;
    addTab.setAttribute("aria-expanded", "true");
    menu.append(h("button", { class: "menu-item", type: "button", role: "menuitem", onClick: () => { picker.close(); newTab(); focusTab(); } }, icon("plus"), "New tab"), h("div", { class: "menu-divider" }));
    for (const surface of SURFACES) menu.append(h("button", {
      class: "menu-item", type: "button", role: "menuitem", onClick: () => {
        picker.close();
        openTool(surface.id);
        tabList.querySelector<HTMLElement>(`[data-tool="${surface.id}"]`)?.focus();
      },
    }, icon(surface.icon), surface.title, tabs.includes(surface.id) ? icon("check") : null));
    // Populate before measuring; keyboard opening starts inside the menu.
    picker.reposition();
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    items[0]?.focus();
    menu.addEventListener("keydown", (event) => {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (index + 1) % items.length
          : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : undefined;
      if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
      if (event.key === "Tab") { picker.close(); addTab.focus(); }
    });
  } }, icon("plus"));
  root.querySelector(".workbench-top")?.append(tabList, addTab);
  root.append(body);
  // Created once so its search field and expansion state survive re-renders.
  const orchestraPanel = createOrchestraPanel(store, controller, host);
  const timelinePanel = createTimelinePanel(store, controller, isVisible);
  // One side chat instance; its context follows the selected main session.
  const sideChat = createSideChat(store, controller, host);
  store.watch((state) => [state.session?.id, state.session?.title, state.selection.sessionId, state.projects], (_slice, state) => {
    sideChat.setContext(state.session && state.selection.sessionId === state.session.id ? sessionSideChatContext(store, state.session.id) : undefined);
  });
  const filesPanel = createFilesPanel(store, controller, isVisible);
  const terminalPanel = createTerminalPanel(store, controller, isVisible);
  const browserPanel = createBrowserPanel(store, controller, isVisible);

  const available = (): readonly SurfaceDefinition[] => {
    const enabled = new Set(store.get().enabledPlugins);
    return SURFACES.filter((surface) => surface.kind === "core" || enabled.has(surface.id));
  };

  function focusTab(): void {
    tabList.querySelector<HTMLElement>(`[data-tool="${openSurface}"]`)?.focus();
  }

  function newTab(): void {
    const id = `new-tab-${++nextBlankId}`;
    tabs.push(id);
    selectTab(id);
  }

  /** Launcher choices fill their blank tab. The + menu opens an additional
   * tool tab; selecting an already open tool focuses its retained instance. */
  function openTool(surfaceId: string, fillBlank = false): void {
    const surface = SURFACES.find((candidate) => candidate.id === surfaceId);
    if (!surface) return;
    if (surface.kind === "plugin" && !store.get().enabledPlugins.includes(surfaceId)) controller.setPluginEnabled(surfaceId, true);
    if (!tabs.includes(surfaceId)) {
      const index = fillBlank && isBlankTab(openSurface) ? tabs.indexOf(openSurface!) : -1;
      if (index >= 0) tabs[index] = surfaceId;
      else tabs.push(surfaceId);
    }
    selectTab(surfaceId);
  }

  function selectTab(id: string): void {
    openSurface = id;
    render();
    void refresh();
    if (id === "run-details") {
      const run = selectedRun();
      if (run !== undefined && run.id !== store.get().selection.runId) void controller.selectRun(run.id);
    }
  }

  function closeTab(id: string): void {
    const index = tabs.indexOf(id);
    if (index < 0) return;
    tabs = tabs.filter((candidate) => candidate !== id);
    if (openSurface === id) openSurface = tabs[Math.min(index, tabs.length - 1)];
    const empty = tabs.length === 0;
    // The shell owns collapse preferences and focus. Render prepares a blank
    // launcher for reopening, and deactivates the tool that was just closed.
    if (empty) onEmpty();
    render();
    if (!empty) (tabList.querySelector<HTMLElement>(`[data-tool="${openSurface}"]`) ?? addTab).focus();
    void refresh();
  }

  function renderTabs(surfaces: readonly SurfaceDefinition[]): void {
    const shown = tabs.flatMap<Pick<SurfaceDefinition, "id" | "title" | "icon">>((id) => isBlankTab(id)
      ? [{ id, title: "New tab", icon: "plus" as const }]
      : surfaces.filter((surface) => surface.id === id));
    const signature = JSON.stringify([shown.map((surface) => surface.id), openSurface]);
    if (signature === tabSignature) return;
    tabSignature = signature;
    const scroll = tabList.scrollLeft;
    replace(tabList, ...shown.map((surface) => {
      const tab = h("button", {
        class: "workbench-tab", type: "button", role: "tab", id: `tool-tab-${surface.id}`,
        title: surface.title, data: { tool: surface.id },
        aria: { selected: String(surface.id === openSurface), controls: "workbench-panel" },
        onClick: () => { selectTab(surface.id); tabList.querySelector<HTMLElement>(`[data-tool="${surface.id}"]`)?.focus(); },
      }, icon(surface.icon), h("span", {}, surface.title));
      tab.tabIndex = surface.id === openSurface ? 0 : -1;
      tab.addEventListener("keydown", (event) => {
        const index = tabs.indexOf(surface.id);
        let target: string | undefined;
        if (event.key === "ArrowRight") target = tabs[(index + 1) % tabs.length];
        else if (event.key === "ArrowLeft") target = tabs[(index + tabs.length - 1) % tabs.length];
        else if (event.key === "Home") target = tabs[0];
        else if (event.key === "End") target = tabs.at(-1);
        else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); closeTab(surface.id); return; }
        if (target === undefined) return;
        event.preventDefault(); selectTab(target);
        tabList.querySelector<HTMLElement>(`[data-tool="${target}"]`)?.focus();
      });
      const close = h("button", { class: "workbench-tab-close", type: "button", title: isBlankTab(surface.id) ? "Close tab" : `Close ${surface.title} tab`, aria: { label: isBlankTab(surface.id) ? "Close tab" : `Close ${surface.title} tab` }, onClick: () => closeTab(surface.id) }, icon("x"));
      close.tabIndex = -1;
      return h("div", { class: `workbench-tab-item${surface.id === openSurface ? " active" : ""}`, role: "presentation" }, tab, close);
    }));
    tabList.scrollLeft = scroll;
    tabList.querySelector<HTMLElement>(`[data-tool="${openSurface}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function render(): void {
    const focused = root.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    // Re-attaching a commit box mid-composition would cancel IME input;
    // render once composition ends instead.
    if (changesMemory.composing && focused instanceof HTMLTextAreaElement) { changesMemory.renderDeferred = true; return; }
    // Persistent inputs (the Timeline filter, Changes commit boxes) lose focus
    // and caret when the surface is re-attached; remember them so typing is
    // not interrupted.
    const editable = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : undefined;
    const caret = editable === undefined ? undefined : { start: editable.selectionStart, end: editable.selectionEnd, scroll: editable.scrollTop };
    const focusPath = focused?.dataset["changePath"];
    const focusGroup = focused?.dataset["changeGroup"];
    const focusLabel = focused?.getAttribute("aria-label");
    const focusRepository = focused?.closest<HTMLElement>(".git-repository")?.dataset["repositoryKey"];
    const previousSurface = body.querySelector<HTMLElement>(".surface");
    if (previousSurface?.dataset["surface"]) surfaceScroll.set(previousSurface.dataset["surface"], previousSurface.scrollTop);
    const diffScroll = [...body.querySelectorAll<HTMLElement>(".git-diff-scroll:not(.split), .git-split-pane")].map((node) => ({
      repository: node.closest<HTMLElement>(".git-repository")?.dataset["repositoryKey"], top: node.scrollTop, left: node.scrollLeft,
      path: node.closest<HTMLElement>(".git-file-diff")?.dataset["diffPath"], side: node.dataset["diffSide"],
    }));
    const surfaces = available();
    tabs = tabs.filter((id) => isBlankTab(id) || surfaces.some((surface) => surface.id === id));
    // A window always has a blank tab after its last tool is closed or disabled.
    if (tabs.length === 0) tabs.push(`new-tab-${++nextBlankId}`);
    if (!tabs.includes(openSurface ?? "")) openSurface = tabs[0];
    renderTabs(surfaces);
    const surface = surfaces.find((candidate) => candidate.id === openSurface);
    body.setAttribute("role", "tabpanel");
    body.id = "workbench-panel";
    body.setAttribute("aria-labelledby", `tool-tab-${openSurface}`);
    // Streaming chat updates must not detach persistent editors, the terminal's
    // hidden textarea, or the browser chrome. Reattachment loses focus and
    // IME composition even if the exact DOM node is inserted again.
    const persistent = surface?.id === "orchestration" ? orchestraPanel.element : surface?.id === "files" ? filesPanel.element
      : surface?.id === "terminal" ? terminalPanel.element
        : surface?.id === "browser" ? browserPanel.element
          : surface?.id === "timeline" ? timelinePanel.element
            : surface?.id === "side-chat" ? sideChat.element : undefined;
    if (surface === undefined) {
      replace(body, renderLauncher((id) => { openTool(id, true); focusTab(); }));
    } else if (persistent === undefined || !body.contains(persistent)) {
      replace(body, renderSurface(surface, surface.id === "orchestration" ? orchestraPanel.element : surface.id === "changes" ? renderChanges()
        : surface.id === "run-details" ? renderDetails()
          : surface.id === "timeline" ? timelinePanel.element
            : surface.id === "files" ? filesPanel.element
              : surface.id === "terminal" ? terminalPanel.element
                : surface.id === "browser" ? browserPanel.element
                  : surface.id === "side-chat" ? sideChat.element : undefined));
    }
    orchestraPanel.setActive(store.get().page === "chat" && surface?.id === "orchestration");
    timelinePanel.setActive(store.get().page === "chat" && surface?.id === "timeline");
    filesPanel.setActive(store.get().page === "chat" && surface?.id === "files");
    terminalPanel.setActive(store.get().page === "chat" && surface?.id === "terminal");
    browserPanel.setActive(store.get().page === "chat" && surface?.id === "browser");
    if (editable !== undefined && editable.isConnected && document.activeElement !== editable) {
      editable.focus({ preventScroll: true });
      if (caret !== undefined && caret.start !== null && caret.end !== null) editable.setSelectionRange(caret.start, caret.end);
      if (caret !== undefined) editable.scrollTop = caret.scroll;
    }
    const visibleSurface = body.querySelector<HTMLElement>(".surface");
    if (visibleSurface && surface) visibleSurface.scrollTop = surfaceScroll.get(surface.id) ?? 0;
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
    return h("div", { class: "changes-content" }, run === undefined ? h("div", { class: "panel-empty-state" }, icon("list-bullets"), h("strong", {}, "The details behind the work"), h("p", {}, "Run a task to see its model, account, usage and execution history here."))
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
    const session = viewSessionId;
    const project = store.get().projects.find((candidate) => candidate.id === selected);
    const path = await controller.selectDirectory("Choose a repository folder inside this workspace", viewSessionId === undefined ? project?.path : store.get().workspace?.path);
    if (path !== undefined && selected === projectId && session === viewSessionId) rescan({ repositoryPath: path });
  }

  /** Serialize reads and invalidate replies on either workspace or repository changes. */
  // Keep polling responsive after edits, then back off on stable worktrees.
  let pollDelay = 2000;
  let nextPoll = 0;
  /** `force` (after a Git operation) guarantees one more read even if a poll is in flight. */
  async function refresh(force = false): Promise<void> {
    const state = store.get();
    // Read the project this panel's repository state belongs to, never the
    // live selection directly: store watchers are batched to animation
    // frames (which pause while the window is hidden), so the selection can
    // change before the watcher below resets `repositories`. Mixing the new
    // project with the old repository paths read the wrong folder. When they
    // differ, wait; the watcher resets the panel and refreshes.
    const selected = projectId;
    if (inFlight) { if (force) rereadRequested = true; return; }
    if (document.hidden || openSurface !== "changes" || !isVisible() || state.host.status !== "ready" || selected === undefined
      || selected !== state.selection.projectId || (viewSessionId !== undefined && viewSessionId !== state.selection.sessionId)) return;
    inFlight = true;
    const version = generation;
    const viewing = viewSessionId;
    const current = () => generation === version && projectId === selected && store.get().selection.projectId === selected && viewSessionId === viewing && (viewing === undefined || store.get().selection.sessionId === viewing);
    try {
      if (repositories === undefined) {
        let found = await controller.discoverProjectRepositories(selected, discoveryOptions, viewSessionId);
        if (!current()) return;
        let saved: string | null = null;
        try { saved = localStorage.getItem(`changes.repository.${selected}`); } catch { /* Use discovery order. */ }
        // Manually selected/deep repositories may not be in the shallow scan
        // after restarting. Revalidate that preference through the host.
        if (found.selectedPath === undefined && saved && !found.paths.includes(saved)) {
          try { found = await controller.discoverProjectRepositories(selected, { repositoryPath: saved }, viewSessionId); }
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
      let changed = false;
      // A failed repository does not hide successful siblings in All repositories.
      for (const path of paths) {
        let result: { snapshot?: ProjectChanges; error?: string };
        try { result = { snapshot: await controller.getProjectChanges(selected, path, viewSessionId) }; }
        catch (failure) { result = { error: failure instanceof Error ? failure.message : String(failure) }; }
        if (!current()) return;
        if (JSON.stringify(snapshots.get(path)) !== JSON.stringify(result)) {
          snapshots.set(path, result);
          changed = true;
        }
      }
      if (changed) render();
      pollDelay = changed ? 2000 : Math.min(10_000, pollDelay * 2);
      nextPoll = Date.now() + pollDelay;
    } catch (failure) {
      if (!current()) return;
      error = failure instanceof Error ? failure.message : String(failure);
      render();
    } finally {
      inFlight = false;
      // A picker change during an old read should start immediately, not wait
      // for the next polling tick. Never run concurrent Git reads for this view.
      if (!current() || rereadRequested) { rereadRequested = false; void refresh(); }
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
        : projectId === undefined ? h("p", { class: "note" }, store.get().selection.sessionId === undefined ? "Open a project to see its changes." : "Attach a project to view Git changes.")
        : repositories === undefined ? h("p", { class: "note" }, "Finding repositories…")
        : repositories.paths.length === 0 ? h("p", { class: "note" }, "No repositories found. Scan deeper or choose a folder inside this project.") : null,
      repositories?.limited ? h("p", { class: "note" }, "Discovery reached its scan limit. Scan deeper or choose a repository folder.") : null,
      ...(repositories?.warnings ?? []).map((warning) => h("p", { class: "note" }, warning)),
      ...paths.map((path) => renderRepository(path)),
    );
  }

  /**
   * Runs one Git operation for a repository row: one at a time per
   * repository, with a progress label, then an outcome line and an immediate
   * re-read. A reply for a folder the panel has since left is dropped.
   * Success lines clear after a few seconds; errors stay until dismissed.
   */
  async function track(key: string, label: string, operation: () => Promise<{ readonly summary: string; readonly conflicts?: boolean }>): Promise<boolean> {
    if (projectId === undefined || !key.startsWith(`${projectId}:`) || changesMemory.pending.has(key)) return false;
    const owner = projectId, session = viewSessionId;
    const same = () => projectId === owner && viewSessionId === session;
    changesMemory.pending.set(key, label);
    changesMemory.results.delete(key);
    render();
    let ok = false;
    try {
      const result = await operation();
      if (!same()) return false;
      // Conflicts are explained by the persistent merge banner instead.
      if (!result.conflicts) {
        const outcome = { text: result.summary, tone: "success" as const };
        changesMemory.results.set(key, outcome);
        window.setTimeout(() => {
          if (changesMemory.results.get(key) === outcome) { changesMemory.results.delete(key); render(); }
        }, 6000);
      }
      ok = true;
    } catch (failure) {
      if (!same()) return false;
      changesMemory.results.set(key, { text: failure instanceof Error ? failure.message : String(failure), tone: "error" });
    } finally {
      if (same()) changesMemory.pending.delete(key);
    }
    render();
    pollDelay = 2000;
    void refresh(true);
    return ok;
  }

  function renderRepository(path: string): HTMLElement {
    const result = snapshots.get(path);
    const project = store.get().projects.find((candidate) => candidate.id === projectId);
    const key = `${projectId}:${path}`;
    // Capture the folder this section was rendered for; a click that races a
    // project switch must not run against the newly selected project.
    const owner = projectId!, session = viewSessionId;
    return renderRepositoryChanges({
      key, label: path === "." ? project?.path.split("/").at(-1) ?? "Repository" : path,
      isolated: viewSessionId !== undefined,
      act: (request, label) => track(key, label, async () => (await controller.sourceControl(owner, path, session, request))),
      checkout: (ref, head, label) => track(key, label, async () => {
        const branches = await controller.checkoutProjectBranch(owner, ref, head, path);
        return { summary: `Switched to ${branches.current ?? "the selected commit"}.` };
      }),
      loadBranches: () => controller.projectBranches(owner, path, session),
      ...(result?.snapshot === undefined ? {} : { snapshot: result.snapshot }), ...(result?.error === undefined ? {} : { error: result.error }),
      memory: changesMemory, redraw: render, openFile: (filePath) => {
        // Resolve the session directory through the host even when workspace
        // inspection is still loading. Never open an isolated diff in the
        // main checkout because its cached workspace path is unavailable.
        if (viewSessionId !== undefined) void controller.openSessionPath(viewSessionId, path === "." ? filePath : `${path}/${filePath}`);
        else if (project !== undefined) void controller.openPath(filePath, path === "." ? project.path : `${project.path}/${path}`);
      },
    });
  }

  // Poll current filesystem changes even when a tool produces no native diff.
  // Refresh also follows project selection and run start/finish, independently
  // of chat deltas, so streaming text never starts a Git process per token.
  const interval = window.setInterval(() => { if (Date.now() >= nextPoll) void refresh(); }, 2000);
  // Hidden windows throttle timers; catch up as soon as the window is shown.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });
  window.addEventListener("beforeunload", () => window.clearInterval(interval), { once: true });
  store.watch((state) => [state.selection.projectId, state.host.status, state.runs, Object.keys(state.live).join("|"), state.workspace, state.selection.sessionId, state.session], () => {
    const state = store.get();
    const selected = state.selection.projectId;
    const selectedSession = state.session?.id === state.selection.sessionId ? state.session : state.sessions.find((entry) => entry.id === state.selection.sessionId);
    const isolatedSession = selectedSession?.workspaceMode === "isolated" ? state.selection.sessionId : undefined;
    // A different folder (project, or isolated worktree versus project
    // folder) invalidates repository discovery, selections, and replies.
    if (selected !== projectId || isolatedSession !== viewSessionId) {
      projectId = selected;
      viewSessionId = isolatedSession;
      repositories = undefined;
      repository = undefined;
      discoveryOptions = {};
      generation++;
      snapshots.clear();
      error = undefined;
      clearChangesMemory(changesMemory);
      render();
    }
    void refresh();
  });

  // Settings changes affect availability; enabling a plugin never opens tabs.
  store.watch((state) => [state.enabledPlugins, state.page], () => { render(); void refresh(); });
  store.watch((state) => state.toolRequest?.seq, (seq) => {
    const request = store.get().toolRequest;
    if (seq === undefined || request === undefined) return;
    openTool(request.id, true);
    if (request.id === "side-chat") {
      if (request.draft !== undefined) sideChat.addDraft(request.draft);
      sideChat.focus();
    }
  });
  store.watch((state) => [state.selection.runId, state.journal, state.live, state.runs, state.session], () => {
    if (openSurface === "run-details") render();
  });
}

/** Picker value for "All repositories"; the panel stores it as "". */
const ALL_REPOSITORIES = "__all__";

function renderSurface(surface: SurfaceDefinition, content?: HTMLElement): HTMLElement {
  return h("div", { class: "surface", data: { surface: surface.id } },
    content ?? h("div", { class: "placeholder" },
      h("span", { class: "placeholder-icon" }, icon(surface.icon)),
      h("p", { class: "placeholder-title" }, surface.kind === "core" ? "No changes yet" : `${surface.title} is not available yet`),
      h("p", { class: "placeholder-text" }, surface.kind === "core"
        ? "Code changes and diffs from runs will appear here."
        : `${surface.description} This plugin is a preview with no functionality yet.`),
    ),
  );
}

/** Blank tabs have independent identities; tools retain one shared panel per
 * type because their underlying browser/shell/editor state is session-owned. */
function isBlankTab(id: string | undefined): boolean { return id?.startsWith("new-tab-") ?? false; }

/** Restore the original tool list as the contents of a blank workbench tab. */
function renderLauncher(open: (id: string) => void): HTMLElement {
  return h("div", { class: "launcher" },
    h("div", { class: "launcher-list", role: "group", aria: { label: "Open a tool" } }, ...SURFACES.map((surface) => h("button", {
      class: "launcher-item", type: "button", title: `${surface.title} · ${surface.description}`, aria: { label: surface.title }, onClick: () => open(surface.id),
    }, icon(surface.icon), h("span", { class: "launcher-label sr-only" }, surface.title), surface.preview ? h("span", { class: "soon" }, "Preview") : null))),
  );
}
