/**
 * The machine service: lifecycle rules, persistence and the driver, composed.
 *
 * Each operation follows the same shape. It moves the machine into a transient
 * state inside the store's write lock (which rejects illegal and concurrent
 * requests), calls the driver, and then settles the record. A driver failure
 * settles as `failed` with the reason, never as a plausible-looking success.
 *
 * Snapshots are the point of the service. Restoring a project machine to an
 * earlier snapshot cannot be requested from inside that machine, because the
 * guest stops existing during the rollback, so this service runs outside the
 * machines it manages and is the only component allowed to perform it.
 */
import { randomUUID } from "node:crypto";
import { MachineOperationFailedError, SnapshotNotFoundError, VmManagerError } from "./errors.js";
import { beginOperation, completeOperation, failOperation, reconcileInterrupted } from "./lifecycle.js";
import type { MachineDriver } from "./drivers/types.js";
import type { MachineStore } from "./store.js";
import type { MachineOperation, MachineRecord, MachineSpec, SnapshotRecord } from "./types.js";

export interface VmManagerServiceOptions {
  /** Injected in tests so records are comparable; defaults to `randomUUID`. */
  readonly newId?: () => string;
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

export class VmManagerService {
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly store: MachineStore,
    private readonly driver: MachineDriver,
    options: VmManagerServiceOptions = {},
  ) {
    this.newId = options.newId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  get driverName(): string {
    return this.driver.name;
  }

  get driverCapabilities(): MachineDriver["capabilities"] {
    return this.driver.capabilities;
  }

  list(): Promise<readonly MachineRecord[]> {
    return this.store.list();
  }

  get(machineId: string): Promise<MachineRecord> {
    return this.store.require(machineId);
  }

  /**
   * Marks machines whose operation was interrupted by a restart. Run once at
   * startup, before serving requests: the alternative, assuming the previous
   * state still holds, would let a client act on a machine whose disk may have
   * been half restored.
   */
  async reconcile(): Promise<readonly MachineRecord[]> {
    const interrupted: MachineRecord[] = [];
    for (const machine of await this.store.list()) {
      if (machine.pending === undefined) continue;
      interrupted.push(await this.store.mutate(machine.id, (record) => reconcileInterrupted(record, this.at()) ?? record));
    }
    return interrupted;
  }

  async create(spec: MachineSpec): Promise<MachineRecord> {
    const id = this.newId();
    const at = this.at();
    await this.store.insert({
      id,
      spec,
      state: "creating",
      driver: this.driver.name,
      createdAt: at,
      updatedAt: at,
      handle: {},
      snapshots: [],
      pending: { operation: "create", from: "creating", startedAt: at },
    });
    return this.settle(id, "create", async () => {
      const handle = await this.driver.create(id, spec);
      return { handle };
    });
  }

  async start(machineId: string): Promise<MachineRecord> {
    const machine = await this.begin(machineId, "start");
    return this.settle(machineId, "start", async () => {
      await this.driver.start(machineId, machine.handle);
      return {};
    });
  }

  async stop(machineId: string): Promise<MachineRecord> {
    const machine = await this.begin(machineId, "stop");
    return this.settle(machineId, "stop", async () => {
      await this.driver.stop(machineId, machine.handle);
      return {};
    });
  }

  /**
   * Captures a restorable state. The snapshot record is appended in the same
   * store update that settles the machine, so a listed snapshot is always one
   * the driver confirmed.
   */
  async snapshot(machineId: string, label?: string): Promise<MachineRecord> {
    const machine = await this.begin(machineId, "snapshot");
    const snapshotId = this.newId();
    return this.settle(machineId, "snapshot", async () => {
      const result = await this.driver.snapshot(machineId, machine.handle, snapshotId);
      const capturedFrom = machine.pending?.from ?? machine.state;
      const snapshot: SnapshotRecord = {
        id: snapshotId,
        machineId,
        label: label ?? `snapshot-${snapshotId.slice(0, 8)}`,
        capturedAt: this.at(),
        capturedFrom,
        sizeBytes: result.sizeBytes,
        handle: result.handle,
      };
      return { snapshots: [...machine.snapshots, snapshot] };
    });
  }

  /**
   * Rolls a machine back to one of its snapshots. The machine is left stopped:
   * a disk-only driver cannot resume a kernel whose disk changed underneath
   * it, and a caller that wants the machine running asks for `start`, which
   * keeps the decision visible instead of implied.
   */
  async restore(machineId: string, snapshotId: string): Promise<MachineRecord> {
    const existing = await this.store.require(machineId);
    const snapshot = existing.snapshots.find((entry) => entry.id === snapshotId);
    if (snapshot === undefined) throw new SnapshotNotFoundError(machineId, snapshotId);
    const machine = await this.begin(machineId, "restore");
    return this.settle(machineId, "restore", async () => {
      await this.driver.restore(machineId, machine.handle, snapshot);
      return {};
    });
  }

  /**
   * Deletes a snapshot without changing the machine's state. It is not a
   * lifecycle operation, but it is refused while one is in flight so a
   * restore cannot lose its source midway.
   */
  async deleteSnapshot(machineId: string, snapshotId: string): Promise<MachineRecord> {
    const machine = await this.store.require(machineId);
    const snapshot = machine.snapshots.find((entry) => entry.id === snapshotId);
    if (snapshot === undefined) throw new SnapshotNotFoundError(machineId, snapshotId);
    if (machine.pending !== undefined) {
      throw new MachineOperationFailedError(machineId, "deleteSnapshot", `machine is ${machine.state}`);
    }
    await this.driver.deleteSnapshot(machineId, machine.handle, snapshot);
    return this.store.mutate(machineId, (record) => ({
      ...record,
      snapshots: record.snapshots.filter((entry) => entry.id !== snapshotId),
      updatedAt: this.at(),
    }));
  }

  /** Releases the machine and its snapshots. The record is kept as `destroyed`
   * so a client that asks again gets an answer rather than a 404. */
  async destroy(machineId: string): Promise<MachineRecord> {
    const machine = await this.begin(machineId, "destroy");
    return this.settle(machineId, "destroy", async () => {
      await this.driver.destroy(machineId, machine.handle);
      return { snapshots: [] };
    });
  }

  private at(): string {
    return this.now().toISOString();
  }

  private begin(machineId: string, operation: MachineOperation): Promise<MachineRecord> {
    return this.store.mutate(machineId, (record) => beginOperation(record, operation, this.at()));
  }

  /**
   * Runs the driver call and writes its outcome. Driver errors are recorded
   * and rethrown: a `DriverUnsupportedError` keeps its 501 so an unimplemented
   * operation is distinguishable from one that was attempted and failed.
   */
  private async settle(
    machineId: string,
    operation: MachineOperation,
    work: () => Promise<Partial<Pick<MachineRecord, "handle" | "snapshots">>>,
  ): Promise<MachineRecord> {
    let patch: Partial<Pick<MachineRecord, "handle" | "snapshots">>;
    try {
      patch = await work();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.store.mutate(machineId, (record) => failOperation(record, operation, reason, this.at()));
      if (error instanceof VmManagerError) throw error;
      throw new MachineOperationFailedError(machineId, operation, reason);
    }
    return this.store.mutate(machineId, (record) => completeOperation(record, this.at(), patch));
  }
}
