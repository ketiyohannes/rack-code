/**
 * Git change browser presentation: compact index/working-tree lists and one
 * selected file's numbered diff. Memory lives with the workbench so polling
 * preserves selection and collapsed sections. All actions here are read-only.
 */
import type { ProjectChangeFile, ProjectChangeGroup, ProjectChanges, ProjectChangeStatus } from "../../../contracts/desktop/index.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";
import { diffFiles, diffRows, splitDiffRows, type DiffRow } from "./change-diff.js";

export interface ChangesMemory {
  readonly selectedFiles: Map<string, string>;
  readonly collapsedGroups: Set<string>;
  split: boolean;
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

export function renderRepositoryChanges(input: RepositoryViewInput): HTMLElement {
  const { memory, snapshot } = input;
  const files = snapshot === undefined ? [] : filesFor(snapshot);
  const selected = files.find((file) => fileKey(file) === memory.selectedFiles.get(input.key));
  const section = h("section", { class: "git-repository", aria: { label: input.label }, data: { repositoryKey: input.key } },
    h("div", { class: "git-repository-heading" }, icon("git-branch"),
      h("span", { class: "git-repository-name", title: input.label }, input.label),
      snapshot?.branch === undefined ? null : h("span", { class: "git-branch-name", title: snapshot.branch }, snapshot.branch)),
  );
  if (input.error !== undefined || snapshot === undefined || snapshot.status !== "ready") {
    section.append(h("p", { class: input.error === undefined ? "git-empty" : "error-line" }, input.error ?? (snapshot === undefined ? "Loading changes…" : "Repository unavailable. Rescan to refresh it.")));
    return section;
  }
  for (const group of GROUPS) {
    const entries = files.filter((file) => file.group === group.id).sort((a, b) => a.path.localeCompare(b.path));
    if (entries.length === 0 && group.id !== "changes") continue;
    const key = `${input.key}:${group.id}`;
    const details = h("details", { class: "git-change-group", open: !memory.collapsedGroups.has(key) },
      h("summary", {}, icon("caret-right", { className: "activity-caret" }), h("span", {}, group.label), h("span", { class: "git-group-count" }, entries.length)),
      h("div", { class: "git-file-list", role: "listbox", aria: { label: group.label } }, ...entries.map((file) => {
        return renderFileRow(file, file === selected, `${group.label}`, () => {
          memory.selectedFiles.set(input.key, fileKey(file)); input.redraw();
        });
      })),
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
    if (!((event.target as HTMLElement).classList.contains("git-file-row")) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...section.querySelectorAll<HTMLButtonElement>(".git-file-row")].filter((row) => row.getClientRects().length > 0);
    const current = rows.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
    event.preventDefault(); rows[next]?.focus();
  });
  return section;
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
export function renderFileRow(file: { readonly path: string; readonly status: ProjectChangeStatus; readonly previousPath?: string }, selected: boolean, context: string, select: () => void): HTMLElement {
  const status = STATUS[file.status];
  const name = basename(file.path);
  const folder = file.path.slice(0, Math.max(0, file.path.lastIndexOf("/")));
  return h("button", {
    class: `git-file-row status-${file.status}${selected ? " selected" : ""}`, type: "button", role: "option",
    title: `${file.path} · ${status.label}${file.previousPath === undefined ? "" : ` · from ${file.previousPath}`}`,
    aria: { selected: String(selected), label: `${file.path}, ${status.label}, ${context}` },
    data: { changePath: file.path }, onClick: select,
  }, icon("file-text"), h("span", { class: "git-file-name" }, name), h("span", { class: "git-file-directory" }, folder),
    h("span", { class: "git-file-status", title: status.label }, status.letter));
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
