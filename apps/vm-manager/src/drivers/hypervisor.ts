/**
 * The seam where a real hypervisor driver plugs in.
 *
 * This file intentionally contains no hypervisor code. Every operation fails
 * with `DriverUnsupportedError` (HTTP 501) so that selecting this driver can
 * never be mistaken for having one: a caller receives an explicit "not
 * implemented" instead of a success for a machine that does not exist.
 *
 * Implementing it means, per operation:
 *
 * - `create`: allocate a rootfs and a writable overlay from `spec.image`, set
 *   vCPU/memory/disk limits, create the network interface (TAP device plus the
 *   address plan the control plane expects), start the VMM with an API socket,
 *   boot, and return a handle containing the socket path, the overlay path and
 *   the assigned address. Nothing may be returned before the VMM accepts the
 *   boot request, since the service treats a return value as success.
 * - `start` / `stop`: resume or shut the guest down through the VMM API, with
 *   a bounded wait and a fallback to killing the VMM process. Report a timeout
 *   as a failure; the service then records an unknown outcome, which is
 *   accurate.
 * - `snapshot`: pause the VM, ask the VMM for a snapshot (Firecracker
 *   `CreateSnapshot`, Cloud Hypervisor `vm.snapshot`), persist the memory and
 *   state files plus a copy-on-write disk reference, resume, and report the
 *   real on-disk size. Set `capabilities.liveSnapshots` to true once memory is
 *   captured, because the lifecycle rules use it to decide whether a restored
 *   machine can resume.
 * - `restore`: stop the VM, point the overlay back at the snapshot's disk
 *   state, and leave the machine stopped. The snapshot's files must not be
 *   consumed, since restoring the same snapshot twice is the common case for
 *   repeated safe shots.
 * - `destroy`: kill the VMM, remove the network interface and delete the
 *   machine directory and its snapshots.
 *
 * The service above this port is unchanged by any of that: it already models
 * transient states, failures with unknown outcomes and restart reconciliation.
 */
import { DriverUnsupportedError } from "../errors.js";
import type { MachineDriver } from "./types.js";

export type HypervisorKind = "firecracker" | "cloud-hypervisor";

const UNIMPLEMENTED =
  "no hypervisor integration is compiled into this build; see apps/vm-manager/src/drivers/hypervisor.ts";

/**
 * Returns a driver whose every operation fails loudly. It exists so the rest
 * of the service can be configured, started and exercised against the intended
 * driver name before the hypervisor work lands.
 */
export function createHypervisorDriver(kind: HypervisorKind): MachineDriver {
  const fail = (operation: string): never => {
    throw new DriverUnsupportedError(kind, operation, UNIMPLEMENTED);
  };
  return {
    name: kind,
    capabilities: { implemented: false, simulated: false, liveSnapshots: false },
    create: async () => fail("create"),
    start: async () => fail("start"),
    stop: async () => fail("stop"),
    snapshot: async () => fail("snapshot"),
    restore: async () => fail("restore"),
    deleteSnapshot: async () => fail("deleteSnapshot"),
    destroy: async () => fail("destroy"),
  };
}
