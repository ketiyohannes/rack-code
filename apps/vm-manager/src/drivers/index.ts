/**
 * Driver selection. Startup picks exactly one driver and the service never
 * learns which: it holds the port only.
 */
import { ConfigurationError } from "../errors.js";
import { createLocalDriver } from "./local.js";
import { createHypervisorDriver } from "./hypervisor.js";
import type { MachineDriver } from "./types.js";

export type DriverName = "local" | "firecracker" | "cloud-hypervisor";

export const DRIVER_NAMES: readonly DriverName[] = ["local", "firecracker", "cloud-hypervisor"];

export function isDriverName(value: string): value is DriverName {
  return (DRIVER_NAMES as readonly string[]).includes(value);
}

export function createDriver(name: DriverName, stateDirectory: string): MachineDriver {
  switch (name) {
    case "local":
      return createLocalDriver(stateDirectory);
    case "firecracker":
    case "cloud-hypervisor":
      // Constructed, not refused: the process starts so routing and auth can
      // be exercised, and every machine operation then fails with 501.
      return createHypervisorDriver(name);
    default:
      throw new ConfigurationError(`unknown driver "${String(name)}"; expected one of ${DRIVER_NAMES.join(", ")}`);
  }
}

export type { MachineDriver } from "./types.js";
