/**
 * Entry point. Assembles the configured providers, the JSON documents and the
 * HTTP surface explicitly, as the rest of the repository does: no import-time
 * registration and no service locator.
 *
 * The control plane never runs agents. It holds accounts, subscriptions,
 * machine ownership and daemon locations; work happens in `apps/daemon` inside
 * the machines `apps/vm-manager` creates on its behalf.
 */
import { join } from "node:path";
import { createCloudApplication } from "./application.js";
import { createCloudServer } from "./http/server.js";
import { createRoutes } from "./http/routes.js";
import { createManualProvider } from "./billing/provider.js";
import { createStripeProvider } from "./billing/stripe.js";
import { HttpVmManagerClient, createUnconfiguredVmManagerClient } from "./provisioning/vm-manager-client.js";
import { JsonFileDocument } from "./storage.js";
import { EMPTY_ACCOUNTS_DOCUMENT } from "./accounts/types.js";
import { EMPTY_BILLING_DOCUMENT } from "./billing/types.js";
import { EMPTY_PROVISIONING_DOCUMENT } from "./provisioning/types.js";
import { EMPTY_REGISTRY_DOCUMENT } from "./registry/types.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const paymentProvider = config.paymentProvider === "stripe" ? createStripeProvider() : createManualProvider({ webhookSecret: config.webhookSecret });
const vmManager = config.vmManager === undefined ? createUnconfiguredVmManagerClient() : new HttpVmManagerClient(config.vmManager);

const application = createCloudApplication({
  documents: {
    accounts: new JsonFileDocument(join(config.dataDirectory, "accounts.json"), EMPTY_ACCOUNTS_DOCUMENT),
    billing: new JsonFileDocument(join(config.dataDirectory, "billing.json"), EMPTY_BILLING_DOCUMENT),
    provisioning: new JsonFileDocument(join(config.dataDirectory, "machines.json"), EMPTY_PROVISIONING_DOCUMENT),
    registry: new JsonFileDocument(join(config.dataDirectory, "registry.json"), EMPTY_REGISTRY_DOCUMENT),
  },
  paymentProvider,
  vmManager,
  relaySigningSecret: config.relaySigningSecret,
});

if (!paymentProvider.takesPayment) {
  console.warn(`payment provider "${paymentProvider.name}" takes no payment; subscriptions change only through signed webhook events.`);
}
if (config.vmManager === undefined) {
  console.warn("no vm-manager is configured; machine provisioning answers 501 until RACK_CLOUD_VM_MANAGER_URL and _TOKEN are set.");
}

const server = createCloudServer({
  application,
  routes: createRoutes(application),
  ...(config.relayNodeToken === undefined ? {} : { relayNodeToken: config.relayNodeToken }),
  describe: () => ({
    paymentProvider: { name: paymentProvider.name, takesPayment: paymentProvider.takesPayment },
    machineHosting: config.vmManager === undefined ? "unconfigured" : "configured",
    relayRedemption: config.relayNodeToken === undefined ? "unconfigured" : "configured",
  }),
});

server.listen(config.port, config.host, () => {
  console.log(`cloud listening on http://${config.host}:${config.port} (data: ${config.dataDirectory})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
