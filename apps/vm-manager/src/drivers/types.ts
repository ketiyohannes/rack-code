/**
 * The hypervisor port.
 *
 * Everything that touches real machines lives behind this interface: the
 * service owns identity, state rules and persistence, the driver owns boots,
 * captures and rollbacks. Implementations are expected to be slow and
 * fallible; they must throw rather than return when an operation did not
 * complete, because the service records a throw as an unknown outcome and
 * anything else as success.
 *
 * Implementations in this directory:
 * - `local.ts`            development and tests; simulates machines as directories.
 * - `hypervisor.ts`       the seam for Firecracker / Cloud Hypervisor; every call fails.
 */
import type { DriverHandle, MachineSpec, SnapshotRecord } from "../types.js";

export interface DriverCapabilities {
  /**
   * False for a driver whose operations are not implemented. The health
   * endpoint reports it so an operator cannot mistake a wired-up process for
   * a working one.
   */
  readonly implemented: boolean;
  /**
   * True when the driver does not run a hypervisor at all. Simulated drivers
   * are legitimate for development and tests, and must announce themselves.
   */
  readonly simulated: boolean;
  /**
   * True when a snapshot captures guest memory, so a restore returns a running
   * machine. False means disk-only capture: a restored machine must be booted.
   */
  readonly liveSnapshots: boolean;
}

export interface SnapshotResult {
  readonly handle: DriverHandle;
  readonly sizeBytes: number;
}

export interface MachineDriver {
  readonly name: string;
  readonly capabilities: DriverCapabilities;

  /** Provisions and boots a machine, returning the handle used by later calls. */
  create(machineId: string, spec: MachineSpec): Promise<DriverHandle>;
  start(machineId: string, handle: DriverHandle): Promise<void>;
  stop(machineId: string, handle: DriverHandle): Promise<void>;
  /** Captures the current machine state. Called only from `running`/`stopped`. */
  snapshot(machineId: string, handle: DriverHandle, snapshotId: string): Promise<SnapshotResult>;
  /**
   * Rolls the machine back to a snapshot. This is the operation that cannot be
   * driven from inside the machine, and the reason this service is separate
   * from the daemon. Drivers stop the machine first and leave it stopped.
   */
  restore(machineId: string, handle: DriverHandle, snapshot: SnapshotRecord): Promise<void>;
  deleteSnapshot(machineId: string, handle: DriverHandle, snapshot: SnapshotRecord): Promise<void>;
  /** Releases the machine and everything it owns, including its snapshots. */
  destroy(machineId: string, handle: DriverHandle): Promise<void>;
}
