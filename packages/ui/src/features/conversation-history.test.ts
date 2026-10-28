import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_STATE } from "../store.js";
import type { RunView, SessionView } from "@rack/contracts";
import type { WorkflowRun } from "@rack/features/orchestration/types";
import { visibleRuns, visibleWorkflowRuns } from "./conversation-history.js";

const stamp = "2026-10-28T00:00:00.000Z";
const run = (id: string): RunView => ({ id, sessionId: "s", prompt: id, providerId: "fake", accountId: "a", permissionMode: "ask", status: "completed", attemptIds: [], attempts: [], createdAt: stamp, updatedAt: stamp });
const workflow = (id: string, sessionId = "s") => ({ id, sessionId, createdAt: stamp }) as unknown as WorkflowRun;

test("turns replaced by an edit are hidden from the conversation", () => {
  const session: SessionView = { id: "s", messages: [], continuations: [], createdAt: stamp, updatedAt: stamp, supersededRunIds: ["r2", "w1"] };
  const state = { ...INITIAL_STATE, session, runs: [run("r1"), run("r2"), run("r3")],
    orchestra: { ...INITIAL_STATE.orchestra, runs: [workflow("w1"), workflow("w2"), workflow("w3", "other")] } };
  assert.deepEqual(visibleRuns(state).map((entry) => entry.id), ["r1", "r3"]);
  assert.deepEqual(visibleWorkflowRuns(state, "s").map((entry) => entry.id), ["w2"]);
  // Without edits the stored list is returned as is.
  assert.equal(visibleRuns({ ...state, session: { ...session, supersededRunIds: [] } }), state.runs);
});

test("an edit replaces the turn and every later turn, workflow turns included", async () => {
  const { turnsReplacedByEdit } = await import("./conversation-history.js");
  const at = (minute: number) => `2026-10-28T00:0${minute}:00.000Z`;
  const timed = (id: string, minute: number): RunView => ({ ...run(id), createdAt: at(minute) });
  const session: SessionView = { id: "s", messages: [], continuations: [], createdAt: stamp, updatedAt: stamp, supersededRunIds: ["old"] };
  const runs = [timed("r1", 1), timed("r2", 2), timed("old", 3), timed("r3", 4)];
  const state = { ...INITIAL_STATE, session, runs,
    orchestra: { ...INITIAL_STATE.orchestra, runs: [{ ...workflow("w1"), createdAt: at(5) } as WorkflowRun, { ...workflow("w0"), createdAt: at(0) } as WorkflowRun] } };
  // r2, r3 and w1; the already replaced "old" and the earlier w0 do not count.
  assert.equal(turnsReplacedByEdit(state, runs[1]!), 3);
  assert.equal(turnsReplacedByEdit(state, runs[3]!), 2);
  assert.equal(turnsReplacedByEdit({ ...state, orchestra: INITIAL_STATE.orchestra }, runs[3]!), 1);
});

test("only the conversation's own, rerunnable turns can be edited", async () => {
  const { canEditTurn } = await import("./conversation-history.js");
  const session: SessionView = { id: "s", messages: [], continuations: [], createdAt: stamp, updatedAt: stamp, supersededRunIds: ["gone"] };
  const orchestra = INITIAL_STATE.orchestra;
  const started = (id: string, extra: Partial<RunView> = {}): RunView => ({ ...run(id), attemptIds: ["attempt"], ...extra });
  assert.equal(canEditTurn({ session, orchestra }, started("r1")), true);
  assert.equal(canEditTurn({ session, orchestra }, started("gone")), false, "already replaced");
  assert.equal(canEditTurn({ session, orchestra }, started("r2", { approvedPlanRunId: "plan" })), false, "plan implementation");
  assert.equal(canEditTurn({ session, orchestra }, run("r3")), false, "never started, nothing to rerun with");
  assert.equal(canEditTurn({ session, orchestra }, started("r4", { prompt: "" })), false, "nothing to edit");
  assert.equal(canEditTurn({ session, orchestra }, started("r5", { sessionId: "other" })), false, "another conversation");
  assert.equal(canEditTurn({ session: { ...session, parentSessionId: "parent" }, orchestra }, started("r6")), false, "a workflow agent's conversation");
});

test("a conversation that runs a workflow cannot be edited", async () => {
  const { canEditTurn } = await import("./conversation-history.js");
  const at = (minute: number) => `2026-10-28T00:0${minute}:00.000Z`;
  const session: SessionView = { id: "s", messages: [], continuations: [], createdAt: stamp, updatedAt: stamp, supersededRunIds: ["w-replaced"] };
  const turn: RunView = { ...run("r1"), attemptIds: ["attempt"], createdAt: at(2) };
  const orchestra = INITIAL_STATE.orchestra;
  const withWorkflow = (id: string, minute: number) => ({ ...orchestra, runs: [{ ...workflow(id), createdAt: at(minute) } as WorkflowRun] });
  assert.equal(canEditTurn({ session, orchestra }, turn), true);
  assert.equal(canEditTurn({ session, orchestra: { ...orchestra, bindings: { s: "workflow-1" } } }, turn), false, "bound to a workflow");
  assert.equal(canEditTurn({ session, orchestra: withWorkflow("w1", 3) }, turn), false, "a workflow turn follows");
  assert.equal(canEditTurn({ session, orchestra: withWorkflow("w0", 1) }, turn), true, "only an earlier workflow turn");
  assert.equal(canEditTurn({ session, orchestra: withWorkflow("w-replaced", 3) }, turn), true, "the later workflow turn was already replaced");
  assert.equal(canEditTurn({ session, orchestra: { ...orchestra, bindings: { other: "workflow-1" } } }, turn), true, "another conversation's binding");
});
