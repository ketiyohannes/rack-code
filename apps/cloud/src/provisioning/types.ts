/**
 * Machine assignments: the control plane's record of which account owns which
 * machine in vm-manager.
 *
 * vm-manager knows about machines; it does not know about accounts, and it has
 * no authorization model beyond a single shared token. This record is where
 * ownership lives, and every machine route resolves it before touching the
 * upstream service. Labels on the upstream machine repeat the account ID for
 * operators reading vm-manager directly, but they are not what authorizes a
 * request.
 */

/**
 * `requested` exists for the window where the control plane has recorded its
 * intent but vm-manager has not answered. A record left in that state, or in
 * `failed`, may correspond to a machine that exists upstream: it is kept so an
 * operator can reconcile, and it does not count against the account's quota.
 */
export type AssignmentState = "requested" | "active" | "failed" | "released";

export interface MachineAssignment {
  readonly id: string;
  readonly accountId: string;
  readonly name: string;
  readonly state: AssignmentState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Identifier in vm-manager; absent until it answers the create call. */
  readonly vmMachineId?: string;
  readonly releasedAt?: string;
  readonly failureReason?: string;
}

export interface ProvisioningDocument {
  readonly schema: 1;
  readonly assignments: readonly MachineAssignment[];
}

export const EMPTY_PROVISIONING_DOCUMENT: ProvisioningDocument = { schema: 1, assignments: [] };

/** An assignment is only billable and only counts against quota while held. */
export function holdsResources(assignment: MachineAssignment): boolean {
  return assignment.state === "requested" || assignment.state === "active";
}
