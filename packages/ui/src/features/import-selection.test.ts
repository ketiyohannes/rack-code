import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveredSession } from "@rack/contracts";
import { importKey, pendingImports, selectionState } from "./import-selection.js";

const sessions: DiscoveredSession[] = ["a", "b", "c"].map((nativeSessionId) => ({
  sourceId: "local", providerName: "Provider", nativeSessionId, projectPath: "/tmp/project", title: nativeSessionId,
  createdAt: "2026-10-14T00:00:00.000Z", updatedAt: "2026-10-14T00:00:00.000Z",
  ...(nativeSessionId === "c" ? { importedSessionId: "existing" } : {}),
}));

test("select-all excludes imported sessions and handles partial selection and stale IDs", () => {
  assert.deepEqual(selectionState(sessions, new Set()), { checked: false, indeterminate: false, count: 0, total: 2 });
  assert.deepEqual(selectionState(sessions, new Set([importKey(sessions[0]!)])), { checked: false, indeterminate: true, count: 1, total: 2 });
  const all = new Set(pendingImports(sessions).map(importKey));
  all.add("stale");
  assert.deepEqual(selectionState(sessions, all), { checked: true, indeterminate: false, count: 2, total: 2 });
  assert.equal(selectionState([], all).checked, false);
});
