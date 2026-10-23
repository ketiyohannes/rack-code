import assert from "node:assert/strict";
import test from "node:test";
import { MACHINE_OPERATIONS, beginOperation, canStart, completeOperation, failOperation, reconcileInterrupted } from "./lifecycle.js";
import { InvalidTransitionError } from "./errors.js";
import type { MachineRecord, MachineState } from "./types.js";

function machine(state: MachineState): MachineRecord {
  return {
    id: "m1",
    spec: { name: "project", vcpus: 2, memoryMiB: 2048, diskGiB: 20, image: "rack-base", labels: {} },
    state,
    driver: "test",
    createdAt: "2026-10-23T10:00:00.000Z",
    updatedAt: "2026-10-23T10:00:00.000Z",
    handle: {},
    snapshots: [],
  };
}

test("transient states accept no operation except destroy", () => {
  const transient: MachineState[] = ["creating", "starting", "stopping", "snapshotting", "restoring"];
  for (const state of transient) {
    for (const operation of ["start", "stop", "snapshot", "restore"] as const) {
      assert.equal(canStart(machine(state), operation), false, `${operation} must be refused while ${state}`);
    }
    assert.equal(canStart(machine(state), "destroy"), true, `destroy must release a machine stuck in ${state}`);
  }
  assert.equal(canStart(machine("destroyed"), "destroy"), false, "a destroyed machine is not destroyed twice");
  assert.equal(canStart(machine("destroyed"), "start"), false);
});

test("a failed machine can be retried or released, because its real state is unknown", () => {
  for (const operation of ["start", "stop", "restore", "destroy"] as const) {
    assert.equal(canStart(machine("failed"), operation), true);
  }
  // Capturing a machine whose last operation failed would record a snapshot
  // of contents nobody can describe, so it is refused.
  assert.equal(canStart(machine("failed"), "snapshot"), false);
});

test("beginning an operation records it and blocks a second request", () => {
  const busy = beginOperation(machine("running"), "snapshot", "2026-10-23T10:01:00.000Z");
  assert.equal(busy.state, "snapshotting");
  assert.deepEqual(busy.pending, { operation: "snapshot", from: "running", startedAt: "2026-10-23T10:01:00.000Z" });
  assert.throws(() => beginOperation(busy, "snapshot", "2026-10-23T10:01:01.000Z"), InvalidTransitionError);
  assert.throws(() => beginOperation(busy, "stop", "2026-10-23T10:01:01.000Z"), InvalidTransitionError);
});

test("a snapshot resumes the pre-operation state while a restore settles stopped", () => {
  const at = "2026-10-23T10:02:00.000Z";
  for (const from of ["running", "stopped"] as const) {
    const captured = completeOperation(beginOperation(machine(from), "snapshot", at), at);
    assert.equal(captured.state, from, "capturing does not change what the guest was doing");
    assert.equal(captured.pending, undefined);
  }
  const restored = completeOperation(beginOperation(machine("running"), "restore", at), at);
  assert.equal(restored.state, "stopped", "a disk rollback leaves the machine stopped for an explicit start");
  assert.equal(MACHINE_OPERATIONS.restore.success, "stopped");
});

test("failure records the reason, clears the pending operation and is cleared by the next success", () => {
  const busy = beginOperation(machine("running"), "stop", "2026-10-23T10:03:00.000Z");
  const failed = failOperation(busy, "stop", "hypervisor socket closed", "2026-10-23T10:03:05.000Z");
  assert.equal(failed.state, "failed");
  assert.equal(failed.pending, undefined);
  assert.deepEqual(failed.failure, { operation: "stop", message: "hypervisor socket closed", at: "2026-10-23T10:03:05.000Z" });

  const retried = completeOperation(beginOperation(failed, "stop", "2026-10-23T10:04:00.000Z"), "2026-10-23T10:04:02.000Z");
  assert.equal(retried.state, "stopped");
  assert.equal(retried.failure, undefined, "a successful retry clears the stale reason");
});

test("completing an operation that was never started is rejected", () => {
  assert.throws(() => completeOperation(machine("running"), "2026-10-23T10:05:00.000Z"), InvalidTransitionError);
});

test("an interrupted operation is reconciled as unknown rather than assumed", () => {
  const settled = machine("running");
  assert.equal(reconcileInterrupted(settled, "2026-10-23T11:00:00.000Z"), undefined);

  const interrupted = beginOperation(machine("running"), "restore", "2026-10-23T10:59:00.000Z");
  const reconciled = reconcileInterrupted(interrupted, "2026-10-23T11:00:00.000Z");
  assert.equal(reconciled?.state, "failed");
  assert.equal(reconciled?.failure?.operation, "restore");
  assert.match(reconciled?.failure?.message ?? "", /outcome is unknown/);
});
