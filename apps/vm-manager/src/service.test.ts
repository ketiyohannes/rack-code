import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmManagerService } from "./service.js";
import { EMPTY_MACHINE_DOCUMENT, MachineStore } from "./store.js";
import { MemoryDocument } from "./storage.js";
import { createLocalDriver } from "./drivers/local.js";
import { createHypervisorDriver } from "./drivers/hypervisor.js";
import { InvalidTransitionError, MachineOperationFailedError, SnapshotNotFoundError } from "./errors.js";
import type { MachineDriver } from "./drivers/types.js";
import type { MachineSpec } from "./types.js";

const SPEC: MachineSpec = { name: "project-vm", vcpus: 2, memoryMiB: 2048, diskGiB: 20, image: "rack-base", labels: { accountId: "acc_1" } };

function sequentialIds(): () => string {
  let next = 0;
  return () => `id${++next}`;
}

interface Outcome {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * A driver whose calls are resolved by the test, so an operation can be
 * observed while it is in flight. An outcome set before the driver is called
 * is queued, which keeps tests free of assumptions about how many microtasks
 * the store's write queue takes to reach the driver.
 */
function controllableDriver(): { driver: MachineDriver; release: () => void; fail: (reason: string) => void } {
  let waiting: ((outcome: Outcome) => void) | undefined;
  let queued: Outcome | undefined;
  const pending = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const apply = (outcome: Outcome): void => (outcome.ok ? resolve() : reject(new Error(outcome.reason ?? "failed")));
      if (queued !== undefined) {
        const outcome = queued;
        queued = undefined;
        apply(outcome);
        return;
      }
      waiting = apply;
    });
  const settle = (outcome: Outcome): void => {
    const target = waiting;
    waiting = undefined;
    if (target === undefined) queued = outcome;
    else target(outcome);
  };
  const driver: MachineDriver = {
    name: "controllable",
    capabilities: { implemented: true, simulated: true, liveSnapshots: false },
    create: async () => ({ directory: "/tmp/machine" }),
    start: pending,
    stop: pending,
    snapshot: async () => {
      await pending();
      return { handle: { disk: "/tmp/snapshot" }, sizeBytes: 1024 };
    },
    restore: pending,
    deleteSnapshot: async () => undefined,
    destroy: pending,
  };
  return {
    driver,
    release: () => settle({ ok: true }),
    fail: (reason: string) => settle({ ok: false, reason }),
  };
}

function serviceWith(driver: MachineDriver): { service: VmManagerService; store: MachineStore } {
  const store = new MachineStore(new MemoryDocument(EMPTY_MACHINE_DOCUMENT));
  return { service: new VmManagerService(store, driver, { newId: sequentialIds() }), store };
}

async function withLocalDriver(run: (service: VmManagerService, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "rack-vm-manager-"));
  try {
    const store = new MachineStore(new MemoryDocument(EMPTY_MACHINE_DOCUMENT));
    await run(new VmManagerService(store, createLocalDriver(directory), { newId: sequentialIds() }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creating a machine boots it and records the driver handle", async () => {
  const { service } = serviceWith(controllableDriver().driver);
  const machine = await service.create(SPEC);
  assert.equal(machine.state, "running");
  assert.equal(machine.driver, "controllable");
  assert.deepEqual(machine.handle, { directory: "/tmp/machine" });
  assert.equal(machine.pending, undefined);
  assert.deepEqual(machine.spec.labels, { accountId: "acc_1" });
  assert.deepEqual((await service.list()).map((entry) => entry.id), [machine.id]);
});

test("a second operation is refused while the first is in flight", async () => {
  const { driver, release } = controllableDriver();
  const { service } = serviceWith(driver);
  const machine = await service.create(SPEC);

  const capture = service.snapshot(machine.id, "before-risky-run");
  await assert.rejects(service.snapshot(machine.id), InvalidTransitionError);
  await assert.rejects(service.stop(machine.id), InvalidTransitionError);
  assert.equal((await service.get(machine.id)).state, "snapshotting");

  release();
  const captured = await capture;
  assert.equal(captured.state, "running", "the machine resumes the state it was captured from");
  assert.equal(captured.snapshots.length, 1);
  assert.equal(captured.snapshots[0]?.label, "before-risky-run");
  assert.equal(captured.snapshots[0]?.capturedFrom, "running");
  assert.equal(captured.snapshots[0]?.sizeBytes, 1024);
});

test("a driver failure records an unknown outcome and the operation can be retried", async () => {
  const { driver, release, fail } = controllableDriver();
  const { service } = serviceWith(driver);
  const machine = await service.create(SPEC);

  const stopping = service.stop(machine.id);
  fail("hypervisor refused the shutdown request");
  await assert.rejects(stopping, (error: unknown) => {
    assert.ok(error instanceof MachineOperationFailedError);
    assert.equal(error.status, 502);
    assert.match(error.message, /hypervisor refused/);
    return true;
  });

  const failed = await service.get(machine.id);
  assert.equal(failed.state, "failed", "the service does not guess that the machine is still running");
  assert.equal(failed.failure?.operation, "stop");
  assert.equal(failed.pending, undefined);

  const retry = service.stop(machine.id);
  release();
  const stopped = await retry;
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.failure, undefined);
});

test("an unimplemented driver fails every operation instead of reporting success", async () => {
  const store = new MachineStore(new MemoryDocument(EMPTY_MACHINE_DOCUMENT));
  const service = new VmManagerService(store, createHypervisorDriver("firecracker"), { newId: sequentialIds() });
  await assert.rejects(service.create(SPEC), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 501);
    assert.match(error.message, /does not implement create/);
    return true;
  });
  const [machine] = await service.list();
  assert.equal(machine?.state, "failed", "the record exists and says the machine was never created");
});

test("restoring a snapshot rolls the machine's disk back and leaves it stopped", async () => {
  await withLocalDriver(async (service) => {
    const machine = await service.create(SPEC);
    const disk = machine.handle["disk"];
    assert.ok(disk !== undefined);

    // Stand in for work done inside the machine between the two reads.
    await writeFile(disk, "generation=1 (trusted state)\n", "utf8");
    const captured = await service.snapshot(machine.id, "safe-shot");
    const snapshot = captured.snapshots[0];
    assert.ok(snapshot !== undefined);
    await writeFile(disk, "generation=2 (agent broke the box)\n", "utf8");

    const restored = await service.restore(machine.id, snapshot.id);
    assert.equal(restored.state, "stopped");
    assert.equal(await readFile(disk, "utf8"), "generation=1 (trusted state)\n");

    // The capture survives its restore: repeated safe shots are the point.
    await writeFile(disk, "generation=3\n", "utf8");
    await service.start(machine.id);
    await service.restore(machine.id, snapshot.id);
    assert.equal(await readFile(disk, "utf8"), "generation=1 (trusted state)\n");
  });
});

test("snapshots are addressed per machine and destroying a machine releases its files", async () => {
  await withLocalDriver(async (service, directory) => {
    const machine = await service.create(SPEC);
    const other = await service.create({ ...SPEC, name: "other" });
    const captured = await service.snapshot(machine.id);
    const snapshot = captured.snapshots[0];
    assert.ok(snapshot !== undefined);

    await assert.rejects(service.restore(other.id, snapshot.id), SnapshotNotFoundError);
    await assert.rejects(service.deleteSnapshot(other.id, snapshot.id), SnapshotNotFoundError);

    const withoutSnapshot = await service.deleteSnapshot(machine.id, snapshot.id);
    assert.deepEqual(withoutSnapshot.snapshots, []);
    assert.equal(withoutSnapshot.state, "running", "deleting a capture is not a lifecycle operation");

    const destroyed = await service.destroy(machine.id);
    assert.equal(destroyed.state, "destroyed");
    await assert.rejects(readFile(join(directory, "machines", machine.id, "disk.img"), "utf8"));
    await assert.rejects(service.start(machine.id), InvalidTransitionError);
    assert.equal((await service.get(machine.id)).state, "destroyed", "the record survives for callers that ask again");
  });
});

test("a restart reconciles operations that were in flight", async () => {
  const { driver, release } = controllableDriver();
  const document = new MemoryDocument(EMPTY_MACHINE_DOCUMENT);
  const first = new VmManagerService(new MachineStore(document), driver, { newId: sequentialIds() });
  const machine = await first.create(SPEC);
  const restoring = first.snapshot(machine.id);
  release();
  await restoring;

  const interrupted = first.stop(machine.id); // never released: the process "dies" here
  while ((await first.get(machine.id)).pending === undefined) await new Promise((resolve) => setImmediate(resolve));

  const second = new VmManagerService(new MachineStore(document), driver, { newId: sequentialIds() });
  const reconciled = await second.reconcile();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.state, "failed");
  assert.match(reconciled[0]?.failure?.message ?? "", /service restarted while stop was in flight/);
  assert.deepEqual(await second.reconcile(), [], "reconciliation is idempotent");

  release();
  await interrupted.catch(() => undefined);
});
