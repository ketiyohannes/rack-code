import type { DiscoveredSession } from "@rack/contracts";

/** Stable source identity independent of list ordering or preview focus. */
export function importKey(session: Pick<DiscoveredSession, "sourceId" | "nativeSessionId">): string {
  return JSON.stringify([session.sourceId, session.nativeSessionId]);
}

/** Select-all includes only sessions that have not already been imported. */
export function pendingImports(sessions: readonly DiscoveredSession[]): readonly DiscoveredSession[] {
  return sessions.filter((session) => session.importedSessionId === undefined);
}

export function selectionState(sessions: readonly DiscoveredSession[], selected: ReadonlySet<string>): {
  checked: boolean; indeterminate: boolean; count: number; total: number;
} {
  const pending = pendingImports(sessions);
  const count = pending.filter((session) => selected.has(importKey(session))).length;
  return { checked: pending.length > 0 && count === pending.length,
    indeterminate: count > 0 && count < pending.length, count, total: pending.length };
}
