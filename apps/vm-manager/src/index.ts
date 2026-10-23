/**
 * Entry point. Composes the configured driver, the store and the HTTP surface
 * explicitly, the way the rest of the repository assembles its applications:
 * no import-time registration and no service locator.
 *
 * The service runs on the bare VPS, outside the machines it manages. Keeping
 * it out of the project VMs is a requirement, not a deployment preference: a
 * restore destroys the running guest, so it can only be driven from a process
 * that survives it.
 */
import { join } from "node:path";
import { createDriver } from "./drivers/index.js";
import { createVmManagerServer } from "./http.js";
import { EMPTY_MACHINE_DOCUMENT, MachineStore } from "./store.js";
import { JsonFileDocument } from "./storage.js";
import { VmManagerService } from "./service.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const driver = createDriver(config.driver, config.stateDirectory);
const store = new MachineStore(new JsonFileDocument(join(config.stateDirectory, "machines.json"), EMPTY_MACHINE_DOCUMENT));
const service = new VmManagerService(store, driver);

const interrupted = await service.reconcile();
for (const machine of interrupted) {
  console.warn(`machine ${machine.id}: ${machine.failure?.message ?? "interrupted operation"}`);
}

if (!driver.capabilities.implemented) {
  console.warn(`driver "${driver.name}" is a seam, not an implementation: every machine operation will fail with 501.`);
} else if (driver.capabilities.simulated) {
  console.warn(`driver "${driver.name}" simulates machines on disk and boots nothing. Do not use it to host projects.`);
}

const server = createVmManagerServer({ service, token: config.token });
server.listen(config.port, config.host, () => {
  console.log(`vm-manager listening on http://${config.host}:${config.port} (driver: ${driver.name}, state: ${config.stateDirectory})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // In-flight driver calls are awaited by `close`; records settle before exit.
    server.close(() => process.exit(0));
  });
}
