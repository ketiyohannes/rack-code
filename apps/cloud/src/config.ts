/**
 * Startup configuration, read once from the environment.
 *
 * Secrets are required rather than generated. A control plane that invents a
 * relay signing key on each start would invalidate every ticket on restart and
 * silently diverge between instances; refusing to start is the honest failure.
 * Capabilities that are genuinely optional — a payment provider that takes
 * money, machine hosting, relay nodes — may be absent, and the routes that
 * need them then answer 501 instead of pretending.
 */
import { resolve } from "node:path";
import { ConfigurationError } from "./errors.js";

export type PaymentProviderName = "manual" | "stripe";

export interface CloudConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDirectory: string;
  readonly paymentProvider: PaymentProviderName;
  readonly webhookSecret: string;
  readonly relaySigningSecret: string;
  readonly relayNodeToken: string | undefined;
  readonly vmManager: { readonly baseUrl: string; readonly token: string } | undefined;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): CloudConfig {
  const provider = environment["RACK_CLOUD_PAYMENT_PROVIDER"] ?? "manual";
  if (provider !== "manual" && provider !== "stripe") {
    throw new ConfigurationError(`RACK_CLOUD_PAYMENT_PROVIDER="${provider}" is not a known provider`);
  }

  const portText = environment["RACK_CLOUD_PORT"] ?? "8790";
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError(`RACK_CLOUD_PORT="${portText}" is not a valid port`);
  }

  const vmManagerUrl = environment["RACK_CLOUD_VM_MANAGER_URL"];
  const vmManagerToken = environment["RACK_CLOUD_VM_MANAGER_TOKEN"];
  if ((vmManagerUrl === undefined) !== (vmManagerToken === undefined)) {
    throw new ConfigurationError("RACK_CLOUD_VM_MANAGER_URL and RACK_CLOUD_VM_MANAGER_TOKEN must be set together");
  }

  return {
    // Loopback by default: production deployments sit behind a terminating
    // proxy, and binding every interface by accident would expose account
    // credentials to the public internet over plain HTTP.
    host: environment["RACK_CLOUD_HOST"] ?? "127.0.0.1",
    port,
    dataDirectory: resolve(environment["RACK_CLOUD_DATA_DIR"] ?? ".rack-cloud"),
    paymentProvider: provider,
    webhookSecret: requireSecret(environment, "RACK_CLOUD_WEBHOOK_SECRET"),
    relaySigningSecret: requireSecret(environment, "RACK_CLOUD_RELAY_SIGNING_SECRET"),
    relayNodeToken: environment["RACK_CLOUD_RELAY_NODE_TOKEN"],
    vmManager: vmManagerUrl === undefined || vmManagerToken === undefined ? undefined : { baseUrl: vmManagerUrl, token: vmManagerToken },
  };
}

function requireSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name] ?? "";
  if (value.length < 32) throw new ConfigurationError(`${name} must be set to at least 32 characters`);
  return value;
}
