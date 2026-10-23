import assert from "node:assert/strict";
import test from "node:test";
import { ProvisioningService, type EntitlementReader } from "./service.js";
import { EMPTY_PROVISIONING_DOCUMENT, type ProvisioningDocument } from "./types.js";
import { MemoryDocument } from "../storage.js";
import { NotFoundError, PaymentRequiredError, QuotaExceededError, UpstreamError } from "../errors.js";
import type { VmMachine, VmManagerClient, VmMachineRequest } from "./vm-manager-client.js";
import type { Entitlement } from "../billing/types.js";

const ENTITLED: Entitlement = { planId: "pro", status: "active", machineLimit: 2, snapshotLimit: 2, mayProvision: true };

/** An in-memory stand-in for vm-manager, exercising the same port the HTTP
 * client implements. */
function fakeVmManager(): VmManagerClient & { requests: VmMachineRequest[]; failNext: (error: Error) => void } {
  const machines = new Map<string, VmMachine>();
  const requests: VmMachineRequest[] = [];
  let next = 0;
  let failure: Error | undefined;
  const lookup = (machineId: string): VmMachine => {
    const machine = machines.get(machineId);
    if (machine === undefined) throw new UpstreamError("vm-manager", `machine ${machineId} does not exist`);
    return machine;
  };
  return {
    requests,
    failNext(error) {
      failure = error;
    },
    async createMachine(request) {
      requests.push(request);
      if (failure !== undefined) {
        const thrown = failure;
        failure = undefined;
        throw thrown;
      }
      const machine: VmMachine = { id: `vm_${++next}`, state: "running", snapshots: [] };
      machines.set(machine.id, machine);
      return machine;
    },
    async getMachine(machineId) {
      return lookup(machineId);
    },
    async snapshotMachine(machineId, label) {
      const machine = lookup(machineId);
      const updated: VmMachine = {
        ...machine,
        snapshots: [...machine.snapshots, { id: `snap_${machine.snapshots.length + 1}`, label: label ?? "snapshot", capturedAt: "2026-10-23T10:00:00.000Z", sizeBytes: 1024 }],
      };
      machines.set(machineId, updated);
      return updated;
    },
    async restoreMachine(machineId) {
      const machine = lookup(machineId);
      const restored: VmMachine = { ...machine, state: "stopped" };
      machines.set(machineId, restored);
      return restored;
    },
    async destroyMachine(machineId) {
      const machine = lookup(machineId);
      machines.delete(machineId);
      return { ...machine, state: "destroyed" };
    },
  };
}

function provisioning(initial: Entitlement = ENTITLED): {
  service: ProvisioningService;
  vmManager: ReturnType<typeof fakeVmManager>;
  document: MemoryDocument<ProvisioningDocument>;
  setEntitlement: (entitlement: Entitlement) => void;
} {
  const document = new MemoryDocument<ProvisioningDocument>(EMPTY_PROVISIONING_DOCUMENT);
  const vmManager = fakeVmManager();
  let current = initial;
  const billing: EntitlementReader = { entitlement: async () => current };
  return {
    service: new ProvisioningService(document, vmManager, billing),
    vmManager,
    document,
    setEntitlement: (entitlement) => {
      current = entitlement;
    },
  };
}

test("a provisioned machine is labelled with its owner and recorded as active", async () => {
  const { service, vmManager } = provisioning();
  const { assignment, machine } = await service.provision("acc_1", { name: "project" });
  assert.equal(assignment.state, "active");
  assert.equal(assignment.vmMachineId, machine.id);
  assert.deepEqual(vmManager.requests[0]?.labels, { accountId: "acc_1", assignmentId: assignment.id });
  assert.equal(vmManager.requests[0]?.image, "rack-daemon-base");
  assert.deepEqual((await service.list("acc_1")).map((entry) => entry.id), [assignment.id]);
});

test("the plan's machine limit is enforced and released machines free it again", async () => {
  const { service } = provisioning();
  const first = await service.provision("acc_1", { name: "one" });
  await service.provision("acc_1", { name: "two" });
  await assert.rejects(service.provision("acc_1", { name: "three" }), QuotaExceededError);

  // Another account's machines do not consume this account's quota.
  await service.provision("acc_2", { name: "theirs" });

  await service.release("acc_1", first.assignment.id);
  const third = await service.provision("acc_1", { name: "three" });
  assert.equal(third.assignment.state, "active");
});

test("a lapsed subscription blocks new machines but not recovery of existing ones", async () => {
  const { service, setEntitlement } = provisioning();
  const { assignment } = await service.provision("acc_1", { name: "project" });
  await service.snapshot("acc_1", assignment.id, "safe shot");

  setEntitlement({ ...ENTITLED, status: "canceled", mayProvision: false, blockedReason: "the subscription is canceled" });
  await assert.rejects(service.provision("acc_1", { name: "another" }), PaymentRequiredError);
  // Restoring a machine the account already has must not require a payment:
  // a rollback is how someone recovers a machine they already paid for.
  const restored = await service.restore("acc_1", assignment.id, "snap_1");
  assert.equal(restored.machine.state, "stopped");
});

test("an upstream failure records the attempt and does not consume quota", async () => {
  const { service, vmManager, document } = provisioning();
  vmManager.failNext(new UpstreamError("vm-manager", "connection refused"));
  await assert.rejects(service.provision("acc_1", { name: "project" }), UpstreamError);

  const [attempt] = (await document.read()).assignments;
  assert.equal(attempt?.state, "failed", "the record survives so an operator can reconcile a possibly leaked machine");
  assert.match(attempt?.failureReason ?? "", /connection refused/);

  const retried = await service.provision("acc_1", { name: "project" });
  assert.equal(retried.assignment.state, "active");
});

test("machines are addressable only by the account that owns them", async () => {
  const { service } = provisioning();
  const { assignment } = await service.provision("acc_1", { name: "project" });
  for (const call of [
    () => service.describe("acc_2", assignment.id),
    () => service.snapshot("acc_2", assignment.id),
    () => service.restore("acc_2", assignment.id, "snap_1"),
    () => service.release("acc_2", assignment.id),
  ]) {
    await assert.rejects(call, NotFoundError);
  }
  assert.equal((await service.get("acc_1", assignment.id)).state, "active");
});

test("the snapshot limit counts the captures the machine actually holds", async () => {
  const { service } = provisioning();
  const { assignment } = await service.provision("acc_1", { name: "project" });
  await service.snapshot("acc_1", assignment.id, "first");
  const second = await service.snapshot("acc_1", assignment.id, "second");
  assert.equal(second.machine.snapshots.length, 2);
  await assert.rejects(service.snapshot("acc_1", assignment.id, "third"), QuotaExceededError);
});

test("a released machine cannot be operated on afterwards", async () => {
  const { service } = provisioning();
  const { assignment } = await service.provision("acc_1", { name: "project" });
  const released = await service.release("acc_1", assignment.id);
  assert.equal(released.state, "released");
  assert.equal((await service.release("acc_1", assignment.id)).state, "released", "releasing twice is not an error");
  await assert.rejects(service.describe("acc_1", assignment.id), NotFoundError);
});
