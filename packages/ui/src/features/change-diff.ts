/** Split bounded Git patches into file panels without interpreting code as HTML. */
export interface DiffFile {
  readonly title: string;
  readonly lines: readonly string[];
  readonly added: number;
  readonly removed: number;
}

/** One unified-diff row, with line numbers only for actual source lines. */
export interface DiffRow {
  readonly kind: "added" | "removed" | "context" | "hunk" | "meta";
  readonly text: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export function diffRows(diff: string): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk !== null) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      rows.push({ kind: "hunk", text: line });
    } else if (inHunk && line.startsWith("+")) rows.push({ kind: "added", text: line.slice(1), newLine: newLine++ });
    else if (inHunk && line.startsWith("-")) rows.push({ kind: "removed", text: line.slice(1), oldLine: oldLine++ });
    else if (inHunk && line.startsWith(" ")) rows.push({ kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    else if (line.startsWith("\\ ") || /^(old mode|new mode|rename |copy |similarity |Binary |@@@)/.test(line)) rows.push({ kind: "meta", text: line });
  }
  return rows;
}

export interface SplitDiffRow {
  readonly old?: DiffRow;
  readonly current?: DiffRow;
  readonly heading?: DiffRow;
}

/** Align changed blocks within each hunk; unchanged context occupies both sides. */
export function splitDiffRows(rows: readonly DiffRow[]): readonly SplitDiffRow[] {
  const result: SplitDiffRow[] = [];
  let removed: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) result.push({
      ...(removed[i] === undefined ? {} : { old: removed[i] }), ...(added[i] === undefined ? {} : { current: added[i] }),
    });
    removed = []; added = [];
  };
  for (const row of rows) {
    if (row.kind === "removed") removed.push(row);
    else if (row.kind === "added") added.push(row);
    else {
      flush();
      result.push(row.kind === "context" ? { old: row, current: row } : { heading: row });
    }
  }
  flush();
  return result;
}

export function diffFiles(diff: string): DiffFile[] {
  return diff.split(/(?=^diff --git )/m).filter((part) => part.trim() !== "").map((part) => {
    const lines = part.replace(/\n$/, "").split("\n");
    const header = lines[0] ?? "Changes";
    const target = lines.find((line) => line.startsWith("+++ ") && line !== "+++ /dev/null")?.slice(4)
      ?? header.match(/ ("?b\/.*)$/)?.[1];
    let title = target ?? header;
    if (title.startsWith('"')) {
      try { title = JSON.parse(title) as string; } catch { /* Keep Git's escaped path readable. */ }
    }
    title = title.replace(/^b\//, "");
    // Count actual hunk lines, never +++/--- metadata or binary notices.
    let hunk = false;
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith("@@")) hunk = true;
      else if (hunk && line.startsWith("+")) added++;
      else if (hunk && line.startsWith("-")) removed++;
    }
    return { title, lines, added, removed };
  });
}
