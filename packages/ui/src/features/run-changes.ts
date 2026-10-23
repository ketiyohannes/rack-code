/**
 * Per-response code changes, derived from a run's own tool activity.
 *
 * The transcript shows a collapsible "files changed" summary at the end of
 * each finished response. It is built from the edits the agent reported
 * through its tools, so it works for every run and provider without Git or
 * Timeline opt-in:
 *
 * - Codex `fileChange` items carry `changes: [{ path, kind, diff }]`, where
 *   `diff` is a unified diff (or the full content for an added file).
 * - Claude `Edit`, `MultiEdit` and `Write` inputs carry the replaced and new
 *   text; line positions are unknown, so their rows have no line numbers.
 *
 * Only finished, successful tool calls count: a failed or declined edit was
 * not applied. Changes made indirectly (for example by a shell command or a
 * formatter) are not reported by these tools and therefore not shown; the
 * Changes tab remains the authoritative working-tree view. Pure and
 * display-only: nothing here touches the file system.
 */
import type { TranscriptItem } from "../transcript.js";
import { diffRows, type DiffRow } from "./change-diff.js";

export type RunFileStatus = "added" | "modified" | "deleted";

export interface RunFileChange {
  readonly path: string;
  readonly status: RunFileStatus;
  readonly additions: number;
  readonly deletions: number;
  /** Displayable rows; hunk rows separate individual edits. */
  readonly rows: readonly DiffRow[];
}

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Aggregates one run's file edits by path, in first-edited order. */
export function collectRunChanges(items: readonly TranscriptItem[]): readonly RunFileChange[] {
  const files = new Map<string, { status: RunFileStatus; rows: DiffRow[] }>();
  const record = (path: string, status: RunFileStatus, rows: readonly DiffRow[]) => {
    const current = files.get(path);
    if (current === undefined) { files.set(path, { status, rows: [...rows] }); return; }
    // A file created and then edited in the same response is still "added";
    // a later deletion wins; otherwise keep the earlier classification.
    if (status === "deleted") current.status = "deleted";
    else if (current.status === "deleted") current.status = status === "added" ? "added" : "modified";
    current.rows.push(...rows);
  };
  for (const item of items) {
    if (item.kind !== "tool" || !item.finished || failed(item)) continue;
    for (const change of codexChanges(item)) record(change.path, change.status, change.rows);
    const claude = claudeChange(item);
    if (claude !== undefined) record(claude.path, claude.status, claude.rows);
  }
  return [...files].map(([path, { status, rows }]) => ({
    path, status, rows,
    additions: rows.filter((row) => row.kind === "added").length,
    deletions: rows.filter((row) => row.kind === "removed").length,
  }));
}

/** Matches presentTool's failure rules so the summary agrees with tool cards. */
function failed(item: ToolItem): boolean {
  const output = record(item.output);
  return item.isError === true || output.status === "failed" || output.status === "declined" || output.success === false || output.is_error === true;
}

function codexChanges(item: ToolItem): { path: string; status: RunFileStatus; rows: readonly DiffRow[] }[] {
  if (item.tool !== "fileChange") return [];
  // The completed item (output) is authoritative; the started item is a fallback.
  const output = record(item.output), input = record(item.input);
  const changes = Array.isArray(output.changes) ? output.changes : Array.isArray(input.changes) ? input.changes : [];
  return changes.flatMap((raw) => {
    const change = record(raw);
    const path = typeof change.path === "string" ? change.path : undefined;
    if (path === undefined) return [];
    const kind = typeof change.kind === "string" ? change.kind : record(change.kind).type;
    const status: RunFileStatus = kind === "add" ? "added" : kind === "delete" ? "deleted" : "modified";
    const diff = typeof change.diff === "string" ? change.diff : "";
    // Added/deleted files may be reported as plain content rather than a patch.
    const rows = /^@@ /m.test(diff) ? diffRows(diff)
      : status === "deleted" ? textRows(diff, "removed") : textRows(diff, "added");
    return [{ path, status, rows }];
  });
}

function claudeChange(item: ToolItem): { path: string; status: RunFileStatus; rows: readonly DiffRow[] } | undefined {
  // Some recorded events wrap arguments in `{ input }`, as presentTool handles.
  const outer = record(item.input);
  const input = typeof outer.input === "object" ? record(outer.input) : outer;
  const path = typeof input.file_path === "string" ? input.file_path : undefined;
  if (path === undefined) return undefined;
  const edit = (oldText: unknown, newText: unknown): DiffRow[] => [
    { kind: "hunk", text: "Edit" },
    ...textRows(typeof oldText === "string" ? oldText : "", "removed"),
    ...textRows(typeof newText === "string" ? newText : "", "added"),
  ];
  switch (item.tool) {
    case "Edit": return { path, status: "modified", rows: edit(input.old_string, input.new_string) };
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? input.edits.map(record) : [];
      return { path, status: "modified", rows: edits.flatMap((entry) => edit(entry.old_string, entry.new_string)) };
    }
    // Write may create or overwrite; the previous content is not reported.
    case "Write": return { path, status: "added", rows: [{ kind: "hunk", text: "Write" }, ...textRows(typeof input.content === "string" ? input.content : "", "added")] };
    default: return undefined;
  }
}

/** Unnumbered rows for text whose position in the file is unknown. */
function textRows(text: string, kind: "added" | "removed"): DiffRow[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n").map((line) => ({ kind, text: line }));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
