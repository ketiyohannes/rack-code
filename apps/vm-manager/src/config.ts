/**
 * Startup configuration, read once from the environment.
 *
 * Missing or malformed values are refused at startup rather than defaulted,
 * except where a default is obviously safe (loopback binding, a state
 * directory under the working directory). A service that can destroy machines
 * should not invent an authentication token or guess a driver.
 */
import { resolve } from "node:path";
import { ConfigurationError } from "./errors.js";
import { isDriverName, type DriverName } from "./drivers/index.js";

export interface VmManagerConfig {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly driver: DriverName;
  readonly stateDirectory: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): VmManagerConfig {
  const token = environment["RACK_VM_MANAGER_TOKEN"] ?? "";
  if (token.length < 32) {
    throw new ConfigurationError("RACK_VM_MANAGER_TOKEN must be set to at least 32 characters; the service manages machine lifetimes and has no other authentication");
  }

  const driverName = environment["RACK_VM_MANAGER_DRIVER"] ?? "local";
  if (!isDriverName(driverName)) {
    throw new ConfigurationError(`RACK_VM_MANAGER_DRIVER="${driverName}" is not a known driver`);
  }

  const portText = environment["RACK_VM_MANAGER_PORT"] ?? "8791";
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError(`RACK_VM_MANAGER_PORT="${portText}" is not a valid port`);
  }

  return {
    // Loopback by default: the control plane reaches the service over a
    // private link, and binding every interface by accident would expose
    // machine destruction to the public internet.
    host: environment["RACK_VM_MANAGER_HOST"] ?? "127.0.0.1",
    port,
    token,
    driver: driverName,
    stateDirectory: resolve(environment["RACK_VM_MANAGER_STATE_DIR"] ?? ".rack-vm-manager"),
  };
}
