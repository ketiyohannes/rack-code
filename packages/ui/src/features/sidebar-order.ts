/** Presentation-only ordering: stale IDs disappear and new rows append. */
export function orderedIds(current: readonly string[], saved: readonly string[]): string[] {
  const available = new Set(current);
  return [...new Set([...saved.filter((id) => available.has(id)), ...current])];
}

/** Move one existing sibling before/after another without changing membership. */
export function moveRow(ids: readonly string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return [...ids];
  const next = ids.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}
