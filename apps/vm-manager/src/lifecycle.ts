/**
 * Machine lifecycle rules: which operations are legal, which transient state
 * each one holds, and what a failure means.
 *
 * These are pure functions over records so the policy can be tested without a
 * driver, a store or a socket. Two properties matter:
 *
 * 1. **Mutual exclusion.** An operation starts by moving the machine into a
 *    transient state that no operation accepts as a source. Because the store
 *    applies these functions under its write lock, a second concurrent request
 *    for the same machine is rejected rather than racing the first.
 * 2. **No invented outcomes.** When a driver call throws, the machine becomes
 *    `failed` and keeps the reason. The service does not guess that a failed
 *    stop left the machine running, because a hypervisor that reports an error
 *    may still have performed part of the work.
 */
import { InvalidTransitionError } from "./errors.js";
import type { MachineOperation, MachineRecord, MachineState } from "./types.js";

export interface OperationRule {
  /** States the operation may start from. */
  readonly from: readonly MachineState[];
  /** State held while the driver call is in flight. */
  readonly busy: MachineState;
  /** Resulting state, or `"resume"` to return to the pre-operation state. */
  readonly success: MachineState | "resume";
}

/**
 * `create` has no source state because the record does not exist yet; it is
 * listed for symmetry and used by the service after inserting the record.
 *
 * `restore` deliberately settles on `stopped` rather than resuming: rolling a
 * disk back under a running kernel is not safe, so the driver stops the
 * machine first and the caller decides when to boot the restored machine.
 * `snapshot` resumes instead, because capturing does not change the guest.
 */
export const MACHINE_OPERATIONS: Readonly<Record<MachineOperation, OperationRule>> = {
  create: { from: [], busy: "creating", success: "running" },
  start: { from: ["stopped", "failed"], busy: "starting", success: "running" },
  stop: { from: ["running", "failed"], busy: "stopping", success: "stopped" },
  snapshot: { from: ["running", "stopped"], busy: "snapshotting", success: "resume" },
  restore: { from: ["running", "stopped", "failed"], busy: "restoring", success: "stopped" },
  destroy: { from: ["creating", "starting", "running", "stopping", "stopped", "snapshotting", "restoring", "failed"], busy: "destroying", success: "destroyed" },
};

/**
 * `destroy` accepts transient states so a machine whose creation or restore
 * died halfway can still be released; every other operation requires a settled
 * state. `start` and `stop` accept `failed` because retrying the operation is
 * exactly how an operator resolves an unknown outcome.
 */
export function canStart(record: MachineRecord, operation: MachineOperation): boolean {
  return MACHINE_OPERATIONS[operation].from.includes(record.state);
}

/** Moves a machine into its transient state, recording the operation. */
export function beginOperation(record: MachineRecord, operation: MachineOperation, at: string): MachineRecord {
  if (!canStart(record, operation)) throw new InvalidTransitionError(record.id, operation, record.state);
  const { failure: _cleared, ...rest } = record;
  return {
    ...rest,
    state: MACHINE_OPERATIONS[operation].busy,
    updatedAt: at,
    pending: { operation, from: record.state, startedAt: at },
  };
}

/**
 * Settles a successful operation. `patch` carries driver results (a new handle
 * or snapshot list) so the state change and the data it produced are written
 * in one store update.
 */
export function completeOperation(
  record: MachineRecord,
  at: string,
  patch: Partial<Pick<MachineRecord, "handle" | "snapshots">> = {},
): MachineRecord {
  const pending = record.pending;
  if (pending === undefined) throw new InvalidTransitionError(record.id, "complete", record.state);
  const rule = MACHINE_OPERATIONS[pending.operation];
  const { pending: _pending, failure: _cleared, ...rest } = record;
  return {
    ...rest,
    ...patch,
    state: rule.success === "resume" ? pending.from : rule.success,
    updatedAt: at,
  };
}

/**
 * Settles a failed operation. The machine lands in `failed`, which `start`,
 * `stop`, `restore` and `destroy` all accept, so recovery never requires
 * editing the store by hand.
 */
export function failOperation(record: MachineRecord, operation: MachineOperation, message: string, at: string): MachineRecord {
  const { pending: _pending, ...rest } = record;
  return { ...rest, state: "failed", updatedAt: at, failure: { operation, message, at } };
}

/**
 * Startup reconciliation for a machine whose operation was interrupted by a
 * service restart. The outcome is genuinely unknown: a snapshot may or may not
 * exist on disk, a restore may have partially written a disk. The record says
 * so instead of assuming the previous state still holds.
 */
export function reconcileInterrupted(record: MachineRecord, at: string): MachineRecord | undefined {
  if (record.pending === undefined) return undefined;
  return failOperation(
    record,
    record.pending.operation,
    `the service restarted while ${record.pending.operation} was in flight (started ${record.pending.startedAt}); the outcome is unknown`,
    at,
  );
}
