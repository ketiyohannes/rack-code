/**
 * Provisioning: turning an entitled account's request into a machine in
 * vm-manager, and keeping the ownership record that authorizes every later
 * operation on it.
 *
 * Order matters here. The assignment is recorded as `requested` *before* the
 * upstream call, so a crash or a timeout leaves evidence that a machine may
 * exist; the alternative, recording only on success, silently leaks machines
 * nobody is billed for and nobody can find. A failed call settles the
 * assignment as `failed` with the reason and stops counting against quota.
 */
import { NotFoundError, PaymentRequiredError, QuotaExceededError } from "../errors.js";
import { newId } from "../ids.js";
import { holdsResources, type MachineAssignment, type ProvisioningDocument } from "./types.js";
import type { VmMachine, VmManagerClient } from "./vm-manager-client.js";
import type { Document } from "../storage.js";
import type { Entitlement } from "../billing/types.js";

/** The narrow billing read provisioning needs. Billing does not depend on it. */
export interface EntitlementReader {
  entitlement(accountId: string): Promise<Entitlement>;
}

export interface MachineRequest {
  readonly name: string;
  readonly image?: string;
  readonly vcpus?: number;
  readonly memoryMiB?: number;
  readonly diskGiB?: number;
}

/** The image a machine boots when the caller does not name one. */
const DEFAULT_IMAGE = "rack-daemon-base";

export class ProvisioningService {
  constructor(
    private readonly document: Document<ProvisioningDocument>,
    private readonly vmManager: VmManagerClient,
    private readonly billing: EntitlementReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(accountId: string): Promise<readonly MachineAssignment[]> {
    return (await this.document.read()).assignments.filter((assignment) => assignment.accountId === accountId);
  }

  /**
   * Resolves an assignment the account owns. A machine belonging to someone
   * else answers "not found": confirming that an ID exists would leak the
   * shape of other tenants' deployments.
   */
  async get(accountId: string, assignmentId: string): Promise<MachineAssignment> {
    const assignment = (await this.document.read()).assignments.find((candidate) => candidate.id === assignmentId);
    if (assignment === undefined || assignment.accountId !== accountId) throw new NotFoundError("machine", assignmentId);
    return assignment;
  }

  async provision(accountId: string, request: MachineRequest): Promise<{ assignment: MachineAssignment; machine: VmMachine }> {
    const entitlement = await this.billing.entitlement(accountId);
    if (!entitlement.mayProvision) {
      throw new PaymentRequiredError(entitlement.blockedReason ?? "the subscription does not permit new machines", { planId: entitlement.planId });
    }

    const at = this.now().toISOString();
    const assignment: MachineAssignment = { id: newId("mch"), accountId, name: request.name, state: "requested", createdAt: at, updatedAt: at };
    // The quota check and the reservation share one document update, so two
    // simultaneous requests cannot both pass a limit of one.
    await this.document.update((current) => {
      const held = current.assignments.filter((candidate) => candidate.accountId === accountId && holdsResources(candidate)).length;
      if (held >= entitlement.machineLimit) throw new QuotaExceededError("machines", entitlement.machineLimit, entitlement.planId);
      return { ...current, assignments: [...current.assignments, assignment] };
    });

    let machine: VmMachine;
    try {
      machine = await this.vmManager.createMachine({
        name: request.name,
        image: request.image ?? DEFAULT_IMAGE,
        labels: { accountId, assignmentId: assignment.id },
        ...(request.vcpus === undefined ? {} : { vcpus: request.vcpus }),
        ...(request.memoryMiB === undefined ? {} : { memoryMiB: request.memoryMiB }),
        ...(request.diskGiB === undefined ? {} : { diskGiB: request.diskGiB }),
      });
    } catch (error) {
      await this.settleFailure(assignment.id, error);
      throw error;
    }
    return { assignment: await this.replace({ ...assignment, state: "active", vmMachineId: machine.id, updatedAt: this.now().toISOString() }), machine };
  }

  async describe(accountId: string, assignmentId: string): Promise<{ assignment: MachineAssignment; machine: VmMachine }> {
    const assignment = await this.get(accountId, assignmentId);
    return { assignment, machine: await this.vmManager.getMachine(this.requireUpstream(assignment)) };
  }

  /**
   * Takes a safe shot. The snapshot limit is enforced here because vm-manager
   * has no notion of plans; it counts the captures the upstream machine
   * already holds rather than a local tally, so a capture taken out of band
   * still counts.
   */
  async snapshot(accountId: string, assignmentId: string, label?: string): Promise<{ assignment: MachineAssignment; machine: VmMachine }> {
    const assignment = await this.get(accountId, assignmentId);
    const entitlement = await this.billing.entitlement(accountId);
    const machineId = this.requireUpstream(assignment);
    const existing = await this.vmManager.getMachine(machineId);
    if (existing.snapshots.length >= entitlement.snapshotLimit) {
      throw new QuotaExceededError("snapshots per machine", entitlement.snapshotLimit, entitlement.planId);
    }
    return { assignment, machine: await this.vmManager.snapshotMachine(machineId, label) };
  }

  /**
   * Restores a machine to one of its snapshots. The request is made from the
   * control plane to vm-manager, which runs outside the machine: a guest
   * cannot drive its own rollback, and this path is why the two services are
   * separate. Restoring is allowed while a subscription is lapsed — recovering
   * a broken machine must not require a payment first.
   */
  async restore(accountId: string, assignmentId: string, snapshotId: string): Promise<{ assignment: MachineAssignment; machine: VmMachine }> {
    const assignment = await this.get(accountId, assignmentId);
    return { assignment, machine: await this.vmManager.restoreMachine(this.requireUpstream(assignment), snapshotId) };
  }

  /** Destroys the machine upstream and frees the account's quota. */
  async release(accountId: string, assignmentId: string): Promise<MachineAssignment> {
    const assignment = await this.get(accountId, assignmentId);
    if (assignment.state === "released") return assignment;
    if (assignment.vmMachineId !== undefined) await this.vmManager.destroyMachine(assignment.vmMachineId);
    const at = this.now().toISOString();
    return this.replace({ ...assignment, state: "released", releasedAt: at, updatedAt: at });
  }

  private requireUpstream(assignment: MachineAssignment): string {
    if (assignment.vmMachineId === undefined || assignment.state === "released") {
      throw new NotFoundError("running machine", assignment.id);
    }
    return assignment.vmMachineId;
  }

  private async settleFailure(assignmentId: string, error: unknown): Promise<void> {
    const at = this.now().toISOString();
    const reason = error instanceof Error ? error.message : String(error);
    await this.document.update((current) => ({
      ...current,
      assignments: current.assignments.map((candidate) =>
        candidate.id === assignmentId ? { ...candidate, state: "failed" as const, failureReason: reason, updatedAt: at } : candidate,
      ),
    }));
  }

  private async replace(assignment: MachineAssignment): Promise<MachineAssignment> {
    await this.document.update((current) => ({
      ...current,
      assignments: current.assignments.map((candidate) => (candidate.id === assignment.id ? assignment : candidate)),
    }));
    return assignment;
  }
}
