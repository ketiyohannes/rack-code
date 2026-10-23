/**
 * Historical source and highlighting helpers. Full context reconstructs an
 * inline comparison from exact contents and a complete patch; hunk gaps become
 * numbered context. Only contextRows requires complete, available text on both
 * sides. After-side highlighting explicitly rejects shortened patches.
 */
import { diffRows, type DiffRow } from "./change-diff.js";

/**
 * Changed After-side line numbers from a complete patch. A truncated patch
 * cannot describe every edit, so callers show an explicit notice instead of
 * presenting partial highlighting as a complete comparison.
 */
export function afterChangeLines(diff: string, truncated: boolean): ReadonlySet<number> {
  if (truncated) return new Set();
  return new Set(diffRows(diff).flatMap((row) => row.kind === "added" && row.newLine !== undefined ? [row.newLine] : []));
}

export function sourceLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

export function contextRows(before: string, after: string, diff: string): readonly DiffRow[] {
  const oldLines = sourceLines(before);
  const newLines = sourceLines(after);
  const result: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  const fill = (oldEnd: number, newEnd: number) => {
    while (oldLine < oldEnd && newLine < newEnd) {
      result.push({ kind: "context", text: newLines[newLine - 1] ?? oldLines[oldLine - 1] ?? "", oldLine: oldLine++, newLine: newLine++ });
    }
  };
  for (const row of diffRows(diff)) {
    if (row.kind === "hunk") {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(row.text);
      if (match !== null) fill(Number(match[1]), Number(match[2]));
    } else if (row.kind !== "meta") {
      result.push(row);
      if (row.oldLine !== undefined) oldLine = row.oldLine + 1;
      if (row.newLine !== undefined) newLine = row.newLine + 1;
    }
  }
  fill(oldLines.length + 1, newLines.length + 1);
  return result;
}
