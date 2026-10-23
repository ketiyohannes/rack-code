/**
 * Presentation-only grouping after event folding.
 *
 * Consecutive activity (tool calls, orphan tool outputs, and thinking traces
 * or summaries) collapses into one group, so a run that alternates between
 * thinking and tools reads as a single compact disclosure. Reply text and
 * status messages always break a group.
 *
 * A run of activity becomes a group only when it contains at least one tool
 * call or output and has two or more items. Thinking-only runs and a lone
 * tool call stay standalone items, so reasoning that precedes a reply remains
 * visible by default.
 *
 * Item indices are preserved: a group's `index` is its first item's index,
 * which stays stable while the group grows during streaming, and callers
 * derive disclosure keys from it. Tool/result correlation and the persisted
 * journal are untouched.
 */
import type { TranscriptItem } from "../transcript.js";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" | "tool_output" }>;
/** Items that may join a compacted activity group. */
export type ActivityItem = Extract<TranscriptItem, { kind: "tool" | "tool_output" | "thinking" }>;
export type TranscriptGroup =
  | { readonly kind: "item"; readonly index: number; readonly item: TranscriptItem }
  | { readonly kind: "activity"; readonly index: number; readonly items: readonly ActivityItem[] };

export function isActivityItem(item: TranscriptItem): item is ActivityItem {
  return item.kind === "tool" || item.kind === "tool_output" || item.kind === "thinking";
}

export function isToolItem(item: TranscriptItem): item is ToolItem {
  return item.kind === "tool" || item.kind === "tool_output";
}

/** Whether a consecutive activity run should render as one compacted group. */
export function compacts(items: readonly TranscriptItem[]): boolean {
  return items.length >= 2 && items.some(isToolItem);
}

export function groupConsecutiveActivity(items: readonly TranscriptItem[]): readonly TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  let pending: ActivityItem[] = [];
  let start = 0;
  const flush = () => {
    if (compacts(pending)) groups.push({ kind: "activity", index: start, items: pending });
    else pending.forEach((item, offset) => groups.push({ kind: "item", index: start + offset, item }));
    pending = [];
  };
  items.forEach((item, index) => {
    if (isActivityItem(item)) {
      if (pending.length === 0) start = index;
      pending.push(item);
    } else {
      flush();
      groups.push({ kind: "item", index, item });
    }
  });
  flush();
  return groups;
}
