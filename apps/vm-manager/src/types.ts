/**
 * Domain types for the machines this service owns.
 *
 * A machine is one microVM that normally runs a project's `rack daemon`. The
 * service runs on the bare VPS, outside those machines, because a restore
 * cannot be driven from inside the machine being restored: the guest stops
 * existing halfway through the operation. Every record here therefore
 * describes a machine as the *outside* observes it, never as the guest
 * reports itself.
 */

/**
 * Observable machine states. The six transient states (`creating`, `starting`,
 * `stopping`, `snapshotting`, `restoring`, `destroying`) mean a driver call is
 * in flight; `failed` means the last operation did not complete and the real
 * machine state is unknown until an operator or a retry establishes it.
 */
export type MachineState =
  | "creating"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "snapshotting"
  | "restoring"
  | "destroying"
  | "destroyed"
  | "failed";

/** Lifecycle operations a client may request. */
export type MachineOperation = "create" | "start" | "stop" | "snapshot" | "restore" | "destroy";

/** Requested machine shape. Sizing is validated at the HTTP boundary. */
export interface MachineSpec {
  readonly name: string;
  readonly vcpus: number;
  readonly memoryMiB: number;
  readonly diskGiB: number;
  /** Driver-interpreted image reference (a rootfs name, not a URL to fetch). */
  readonly image: string;
  /** Free-form owner metadata, for example the cloud account and project. */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * Opaque driver-owned location data (file paths, hypervisor socket names,
 * snapshot object IDs). The service stores and returns it without
 * interpretation so that adding a hypervisor needs no schema change here.
 */
export type DriverHandle = Readonly<Record<string, string>>;

/**
 * A captured machine state a restore can return to. Snapshots exist only once
 * the driver confirms the capture; a failed capture leaves no record, so a
 * listed snapshot is always one the service believes is restorable.
 */
export interface SnapshotRecord {
  readonly id: string;
  readonly machineId: string;
  readonly label: string;
  readonly capturedAt: string;
  /** The machine state at capture time, which a live-snapshot driver restores. */
  readonly capturedFrom: MachineState;
  readonly sizeBytes: number;
  readonly handle: DriverHandle;
}

/**
 * The operation currently in flight. It is persisted rather than kept in
 * memory so that a service restart can tell "nothing was running" from "a
 * restore was interrupted and the machine state is unknown".
 */
export interface PendingOperation {
  readonly operation: MachineOperation;
  /** State before the operation, used to resume after a snapshot. */
  readonly from: MachineState;
  readonly startedAt: string;
}

/** Why the last operation failed. Cleared when an operation next succeeds. */
export interface MachineFailure {
  readonly operation: MachineOperation;
  readonly message: string;
  readonly at: string;
}

export interface MachineRecord {
  readonly id: string;
  readonly spec: MachineSpec;
  readonly state: MachineState;
  /** Name of the driver that created the machine; drivers are not portable. */
  readonly driver: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly handle: DriverHandle;
  readonly snapshots: readonly SnapshotRecord[];
  readonly pending?: PendingOperation;
  readonly failure?: MachineFailure;
}
