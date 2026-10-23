/**
 * Standalone historical viewer, mounted instead of the chat application when
 * Electron opens its fixed bundled page with a validated Timeline target.
 * The window owns its selection, filters and display mode independently of
 * the chat sidebar. File responses use a generation check so a slow reply
 * cannot replace a newer selection. No working files are read or written.
 */
import type { TimelineSnapshot, TimelineSnapshotFile, TimelineSnapshotFileView, TimelineSnapshotTarget, TimelineSnapshotChoice } from "@rack/contracts";
import type { HostClient } from "@rack/client/host-client";
import { h, replace } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { applyPalette, applyTheme, loadPalette, loadTheme } from "../theme.js";
import { buildTree, type TreeFolder } from "./timeline-tree.js";
import { diffRows, type DiffRow } from "./change-diff.js";
import { afterChangeLines, contextRows, sourceLines } from "./snapshot-context.js";
import { createDropdown } from "../components/dropdown.js";

type Mode = "diff" | "context" | "split";
/** View modes are an icon toggle; names appear in tooltips and accessible labels. */
const MODES: readonly [Mode, string, IconName][] = [["diff", "Diff", "git-diff"], ["split", "Before / After", "square-split-horizontal"], ["context", "Full context", "text-align-left"]];
const STATUS = { added: "A", modified: "M", deleted: "D", type_changed: "T" } as const;
/** Prevent a small text file containing millions of empty lines flooding the DOM. */
const MAX_ROWS = 10_000;

export function mountSnapshotWindow(root: HTMLElement, host: HostClient, params: URLSearchParams): void {
  applyTheme(loadTheme());
  root.className = "snapshot-window git-changes-content";
  const scope = params.get("scope");
  const contextId = params.get("contextId");
  const checkpointId = params.get("checkpointId");
  if ((scope !== "project" && scope !== "session") || !contextId || !checkpointId) {
    replace(root, h("p", { class: "snapshot-message" }, "Invalid snapshot window."));
    return;
  }
  let target: TimelineSnapshotTarget = { scope, contextId, checkpointId };
  const originalTarget = target;
  let choices: readonly TimelineSnapshotChoice[] = [];
  let snapshotGeneration = 0;
  let snapshot: TimelineSnapshot | undefined;
  let selected = params.get("path") ?? undefined;
  let onlyChanged = true;
  let query = "";
  let mode: Mode = "diff";
  let data: TimelineSnapshotFileView | undefined;
  let fileGeneration = 0;
  const collapsed = new Set<string>();
  const title = h("h1", {}, "Loading snapshot…");
  const metadata = h("span", { class: "snapshot-meta" });
  const checkpointPicker = createDropdown<string>({
    ariaLabel: "Timeline change", variant: "field", menuWidth: 380,
    placeholder: "Loading changes…", icon: "clock-counter-clockwise",
    onChange: (id) => {
      const choice = choices.find((entry) => entry.id === id);
      if (choice !== undefined) void loadSnapshot(choice.target);
    },
  });
  checkpointPicker.setDisabled(true);
  const newer = h("button", { class: "icon-button snapshot-step", type: "button", disabled: true,
    title: "Newer change", aria: { label: "Newer change" }, onClick: () => stepChange(-1) }, icon("arrow-up"));
  const older = h("button", { class: "icon-button snapshot-step", type: "button", disabled: true,
    title: "Older change", aria: { label: "Older change" }, onClick: () => stepChange(1) }, icon("arrow-down"));
  const position = h("span", { class: "snapshot-position", role: "status", aria: { live: "polite" } }, "Loading history…");
  const navigation = h("div", { class: "snapshot-navigation", role: "group", aria: { label: "Timeline change navigation" } },
    h("div", { class: "snapshot-navigation-controls" }, newer, checkpointPicker.element, older), position);
  const heading = h("header", { class: "snapshot-header" },
    h("div", { class: "snapshot-heading" }, h("span", { class: "snapshot-heading-icon", aria: { hidden: "true" } }, icon("clock-counter-clockwise")),
      h("div", { class: "snapshot-heading-text" }, title, metadata)),
    navigation,
    h("button", { class: "icon-button", type: "button", title: "Close window", aria: { label: "Close window" }, onClick: () => window.close() }, icon("x")));
  const changed = h("button", { type: "button", onClick: () => setFileScope(true) }, "Changed files");
  const all = h("button", { type: "button", onClick: () => setFileScope(false) }, "All files");
  const fileScope = h("div", { class: "snapshot-segments", role: "group", aria: { label: "Files to show" } }, changed, all);
  const search = h("input", { type: "search", class: "timeline-search", placeholder: "Find a file", aria: { label: "Find a file" },
    onInput: () => { query = search.value; renderTree(); } });
  const tree = h("div", { class: "snapshot-tree", role: "tree", aria: { label: "Snapshot files" } });
  const sidebar = h("aside", { class: "snapshot-sidebar" }, fileScope, search, tree);
  const filename = h("div", { class: "snapshot-filename" });
  const modeButtons = MODES.map(([value, label, name]) => h("button", { type: "button", class: "icon-button", title: label, aria: { label, pressed: String(value === mode) },
    onClick: () => { mode = value; renderCode(); } }, icon(name)));
  const modePicker = { element: h("div", { class: "snapshot-modes", role: "group", aria: { label: "View mode" } }, ...modeButtons) };
  const code = h("div", { class: "snapshot-code", role: "region", aria: { label: "Historical file contents" } });
  code.tabIndex = 0;
  const content = h("section", { class: "snapshot-content" }, h("div", { class: "snapshot-toolbar" }, filename, modePicker.element), code);
  replace(root, heading, h("div", { class: "snapshot-body" }, sidebar, content));
  message("Loading snapshot…");

  /** Changing file scope preserves selection if the selected file is in scope. */
  function setFileScope(value: boolean): void {
    onlyChanged = value;
    const candidates = snapshot?.files.filter((file) => !value || file.status !== undefined) ?? [];
    if (!candidates.some((file) => file.path === selected)) void selectFile(candidates[0]?.path);
    renderTree();
  }

  function renderTree(): void {
    if (snapshot === undefined) return;
    const count = snapshot.files.filter((file) => file.status !== undefined).length;
    replace(changed, "Changed", h("span", { class: "snapshot-count" }, String(count)));
    replace(all, "All files", h("span", { class: "snapshot-count" }, String(snapshot.files.length)));
    changed.setAttribute("aria-pressed", String(onlyChanged));
    all.setAttribute("aria-pressed", String(!onlyChanged));
    const needle = query.trim().toLowerCase();
    const files = snapshot.files.filter((file) => (!onlyChanged || file.status !== undefined) && file.path.toLowerCase().includes(needle));
    const nodes = buildTree(files);
    const renderFolder = (folder: TreeFolder<TimelineSnapshotFile>, depth: number): HTMLElement[] => {
      const children: HTMLElement[] = [];
      for (const sub of folder.folders) {
        const details = h("details", { class: "timeline-folder", open: !collapsed.has(sub.path) },
          indent(h("summary", { title: sub.path }, icon("caret-right", { className: "activity-caret" }), icon("folder-simple"), h("span", {}, sub.name)), depth),
          ...renderFolder(sub, depth + 1));
        details.addEventListener("toggle", () => {
          if (details.isConnected) { if (details.open) collapsed.delete(sub.path); else collapsed.add(sub.path); }
        });
        children.push(details);
      }
      for (const file of folder.files) {
        const status = file.status === undefined ? "Unchanged" : file.status.replace("_", " ");
        children.push(indent(h("button", {
          class: `git-file-row status-${file.status ?? "unchanged"}${file.path === selected ? " selected" : ""}`, type: "button", role: "treeitem",
          title: `${file.path} · ${status}`, aria: { label: `${file.path}, ${status}`, selected: String(file.path === selected) },
          onClick: () => void selectFile(file.path),
        }, icon("file-text"), h("span", { class: "git-file-name" }, file.path.split("/").at(-1) ?? file.path),
          h("span", { class: `git-file-status status-${file.status ?? "unchanged"}` }, file.status === undefined ? "" : STATUS[file.status])), depth));
      }
      return children;
    };
    replace(tree, ...renderFolder(nodes, 0));
    if (files.length === 0) tree.append(h("p", { class: "snapshot-message" }, "No matching files."));
  }

  async function selectFile(path: string | undefined): Promise<void> {
    selected = path;
    data = undefined;
    const generation = ++fileGeneration;
    filename.textContent = path ?? "No file selected";
    filename.title = path ?? "";
    renderTree();
    updateModes();
    code.scrollTop = 0;
    code.scrollLeft = 0;
    if (path === undefined) { message("No files in this view."); return; }
    message("Loading historical file…");
    try {
      const result = await host.call("timeline.snapshotFile", { ...target, path });
      if (generation !== fileGeneration) return;
      data = result;
      renderCode();
    } catch (error) {
      if (generation === fileGeneration) message(error instanceof Error ? error.message : String(error));
    }
  }

  function updateModes(): void {
    MODES.forEach(([value], index) => {
      const button = modeButtons[index]!;
      button.setAttribute("aria-pressed", String(value === mode));
      button.classList.toggle("active", value === mode);
      button.disabled = data === undefined;
    });
  }

  function message(text: string): void {
    code.classList.remove("snapshot-code-split");
    replace(code, h("p", { class: "snapshot-message" }, text));
  }

  function renderCode(): void {
    updateModes();
    if (data === undefined) return;
    const before = data.before;
    const after = data.after;
    code.classList.toggle("snapshot-code-split", mode === "split");
    if (mode === "split") {
      // Render each exact version independently. Missing/unsupported contents
      // affect only their own pane. Only complete patches supply highlighting;
      // exact source remains readable even when the patch was shortened.
      replace(code, renderVersion("Before", before),
        renderVersion("After", after, afterChangeLines(data.diff, data.diffTruncated), data.diffTruncated));
      return;
    }
    let rows: readonly DiffRow[];
    let notice: string | undefined;
    if (mode === "context" || data.status === undefined) {
      const unavailable = before?.notice ?? after?.notice;
      if (unavailable !== undefined) { message(unavailable); return; }
      if (data.diffTruncated) {
        // A partial patch cannot identify all changed lines accurately.
        // Show exact source with a notice rather than inventing context.
        notice = "Change highlighting is incomplete for this large diff. Showing full available source; use Before / After to compare.";
        rows = sourceLines((after ?? before)?.text ?? "").map((text, i) => ({ kind: "context", text,
          ...(after === undefined ? { oldLine: i + 1 } : { newLine: i + 1 }) }));
      } else rows = contextRows(before?.text ?? "", after?.text ?? "", data.diff);
      if (data.status === undefined) notice = "Unchanged in this snapshot.";
    } else {
      rows = diffRows(data.diff);
      if (rows.length === 0 || (before?.notice !== undefined && after?.notice !== undefined)) {
        message(after?.notice ?? before?.notice ?? "No text changes in this file."); return;
      }
      if (data.diffTruncated) notice = "This diff was shortened for preview.";
    }
    if (rows.length === 0) { message("Empty file."); return; }
    replace(code,
      ...(notice === undefined ? [] : [h("p", { class: "snapshot-message" }, notice)]),
      ...rows.slice(0, MAX_ROWS).map(renderRow),
      ...(rows.length > MAX_ROWS ? [h("p", { class: "snapshot-message" }, `Showing the first ${MAX_ROWS.toLocaleString()} lines.`)] : []));
    // Context keeps the entire source available, but starts near the edit so
    // changes deep in a large file do not require a manual search to find.
    if (mode === "context") code.querySelector<HTMLElement>(".added, .removed")?.scrollIntoView({ block: "center" });
  }

  document.addEventListener("keydown", (event) => {
    if (document.querySelector(".popover") !== null) return;
    if (event.key === "Escape") { event.preventDefault(); window.close(); }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "appearance" || event.key === null) applyTheme(loadTheme());
    if (event.key === "appearance.palette" || event.key === null) applyPalette(loadPalette());
  });

  /** History is newest first. Clamp navigation at either end; the current
   * target advances immediately so fast clicks can step past an in-flight
   * read. Existing generation checks ensure only the final read is rendered.
   */
  function stepChange(direction: -1 | 1): void {
    const index = choices.findIndex((choice) => choice.id === target.checkpointId);
    const next = index < 0 ? undefined : choices[index + direction];
    if (next !== undefined) void loadSnapshot(next.target);
  }

  function updateNavigation(): void {
    const index = choices.findIndex((choice) => choice.id === target.checkpointId);
    newer.disabled = index <= 0;
    older.disabled = index < 0 || index >= choices.length - 1;
    const text = index < 0 ? "History unavailable" : `${index + 1} of ${choices.length}, newest first`;
    if (position.textContent !== text) position.textContent = text;
  }

  /** Snapshot and file generations invalidate both stages when navigating quickly. */
  async function loadSnapshot(next: TimelineSnapshotTarget): Promise<void> {
    target = next;
    const generation = ++snapshotGeneration;
    ++fileGeneration;
    snapshot = undefined;
    data = undefined;
    replace(tree);
    updateModes();
    checkpointPicker.setValue(next.checkpointId);
    updateNavigation();
    title.textContent = "Loading snapshot…";
    metadata.textContent = "";
    filename.textContent = "";
    message("Loading snapshot…");
    try {
      const result = await host.call("timeline.snapshot", next);
      if (generation !== snapshotGeneration) return;
      snapshot = result;
      title.textContent = result.label;
      document.title = `${result.label} — Timeline`;
      const when = new Date(result.createdAt);
      replace(metadata, h("code", { class: "snapshot-sha", title: result.snapshot }, result.snapshot.slice(0, 8)),
        h("time", { title: when.toLocaleString() }, when.toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })));
      const requested = result.files.find((file) => file.path === selected);
      const initial = requested ?? result.files.find((file) => file.status !== undefined) ?? result.files[0];
      if (initial?.status === undefined) onlyChanged = false;
      void selectFile(initial?.path);
    } catch (error) {
      if (generation !== snapshotGeneration) return;
      title.textContent = "Snapshot unavailable";
      message(error instanceof Error ? error.message : String(error));
    }
  }

  /** Refresh navigation without replacing the comparison the user is inspecting. */
  async function refreshHistory(): Promise<void> {
    try {
      const history = await host.call("timeline.snapshotHistory", originalTarget);
      const current = choices.find((choice) => choice.id === target.checkpointId);
      choices = history.entries;
      // A busy repository may push the selected comparison out of the recent
      // history page. Keep that known target selectable without jumping away.
      if (current !== undefined && !choices.some((choice) => choice.id === current.id)) {
        choices = [...choices, current].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      }
      checkpointPicker.setOptions(choices.map((entry) => ({ value: entry.id, label: entry.label,
        description: `${entry.source === "git" ? "Git commit" : "Recorded change"} · ${new Date(entry.createdAt).toLocaleString()} · ${entry.id.slice(-8)}` })), target.checkpointId);
      checkpointPicker.setDisabled(choices.length === 0);
      updateNavigation();
      checkpointPicker.element.title = history.truncated ? "Recent project history (200 entries)" : "Timeline change";
    } catch {
      // Navigation discovery must not hide a snapshot that already loaded.
      checkpointPicker.element.title = "Could not refresh other changes. Reopen this window to retry.";
      if (choices.length === 0) position.textContent = "History unavailable";
    }
  }
  void loadSnapshot(target);
  void refreshHistory();
  const refresh = setInterval(() => { if (document.visibilityState === "visible") void refreshHistory(); }, 4000);
  window.addEventListener("beforeunload", () => clearInterval(refresh), { once: true });
}

function indent<T extends HTMLElement>(node: T, depth: number): T {
  node.style.paddingLeft = `${10 + depth * 14}px`;
  return node;
}

function renderRow(row: DiffRow): HTMLElement {
  if (row.kind === "hunk" || row.kind === "meta") return h("div", { class: "git-diff-hunk" }, row.text);
  return h("div", { class: `git-diff-line ${row.kind}` },
    h("span", { class: "git-line-number" }, row.oldLine ?? ""), h("span", { class: "git-line-number" }, row.newLine ?? ""),
    h("span", { class: "git-line-sign" }, row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "),
    h("span", { class: "git-line-text" }, row.text || " "));
}

/** Each version owns its scroll, line numbering and availability/limit notice. */
function renderVersion(label: "Before" | "After", side: TimelineSnapshotFileView["before"],
  changed: ReadonlySet<number> = new Set(), incomplete = false): HTMLElement {
  const body = h("div", { class: "snapshot-version-code", role: "region", aria: { label: `${label} file contents` } });
  body.tabIndex = 0;
  const unavailable = side === undefined ? `This file does not exist ${label.toLowerCase()} this change.` : side.notice;
  if (unavailable !== undefined) body.append(h("p", { class: "snapshot-message" }, unavailable));
  else {
    const lines = sourceLines(side?.text ?? "");
    replace(body, ...lines.slice(0, MAX_ROWS).map((text, index) =>
      h("div", { class: `snapshot-source-line${changed.has(index + 1) ? " added" : ""}`,
        ...(changed.has(index + 1) ? { aria: { label: `Line ${index + 1}, added or changed` } } : {}) },
        h("span", { class: "git-line-number" }, index + 1),
        h("span", { class: "git-line-text" }, text || " "))));
    if (incomplete) body.prepend(h("p", { class: "snapshot-message" }, "Change highlighting is unavailable for this shortened diff."));
    if (lines.length === 0) body.append(h("p", { class: "snapshot-message" }, "Empty file."));
    if (lines.length > MAX_ROWS) body.append(h("p", { class: "snapshot-message" }, `Showing the first ${MAX_ROWS.toLocaleString()} lines.`));
  }
  return h("section", { class: "snapshot-version", aria: { label } },
    h("h2", { class: "snapshot-version-heading" }, label), body);
}
