#!/usr/bin/env node
/**
 * `rack daemon` — the same host the desktop app runs, without Electron.
 *
 * The composed application, the command surface and every protocol rule are
 * identical to the desktop utility process; `startHost` and
 * `RemoteHostServer` are shared code. What differs is the environment: this
 * process may be the only thing running on a VPS or inside a project VM, it
 * has no windows, and its clients are remote.
 *
 * Two consequences are visible below.
 *
 * **No browser driver.** The shared browser is an Electron view owned by
 * desktop main. A daemon has none, so `createApplication` is called without
 * one and browser commands answer `feature_unavailable` — an honest refusal
 * rather than a silent no-op.
 *
 * **Shutdown is bounded and deliberate.** On SIGINT or SIGTERM the daemon
 * asks the host to cancel active runs and waits for their terminal states to
 * be persisted. A VM that is about to be snapshotted or destroyed must not
 * leave runs recorded as `running` that no process will ever finish; the
 * recovery pass on next start would have to mark them `unknown`, losing the
 * distinction between "cancelled cleanly" and "the machine disappeared".
 */
import { randomUUID } from "node:crypto";

import { EventStream, adoptLegacyDataDirectory, startHost } from "@rack/host";

import { ConfigurationError, USAGE, isPubliclyBound, parseConfig } from "./config.js";
import { DaemonServer, WEBSOCKET_PATH } from "./server.js";
import { createTokenVerifier, loadOrCreateToken } from "./tokens.js";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

// Before the configuration is read, because the pairing token file below
// is derived from the data directory and is written before the host starts.
const dataDirectory = adoptLegacyDataDirectory();

let config;
try {
  config = parseConfig(argv, process.env, dataDirectory);
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message : String(error));
  process.exit(2);
}

const { token, created } = config.tokenFromEnvironment === undefined
  ? await loadOrCreateToken(config.tokenFile)
  : { token: config.tokenFromEnvironment, created: false };

if (config.printToken) {
  // Printed alone, so `rack-daemon --print-token` can be piped or scanned.
  console.log(token);
  process.exit(0);
}

const log = (message: string): void => {
  console.log(`[rack-daemon] ${message}`);
};

// A fresh identity per process: it tells a reconnecting controller that the
// sequence numbers it remembers belong to a stream that no longer exists.
const instanceId = randomUUID();
const events = new EventStream({ bufferSize: config.replayBuffer });

const { api } = await startHost({ dataDirectory: config.dataDirectory }, (event) => {
  events.publish(event);
});

const server = new DaemonServer({
  endpoint: api,
  events,
  machineId: config.machineId,
  instanceId,
  authorize: createTokenVerifier(token),
  onLog: log,
});

const port = await server.listen(config.host, config.port);
log(`machine "${config.machineId}" serving ws://${config.host}:${String(port)}${WEBSOCKET_PATH}`);
log(`records in ${config.dataDirectory}`);
if (created) {
  log(`a pairing token was generated at ${config.tokenFile}; run with --print-token to read it`);
}
if (isPubliclyBound(config.host)) {
  // Loud, because the usual deployment reaches the daemon through the tsnet
  // sidecar or a relay and never needs a public bind.
  log(`WARNING: bound to ${config.host}, which is reachable beyond this machine. The pairing token is the only thing protecting it; prefer loopback plus the tsnet sidecar.`);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received; cancelling active runs (up to ${String(config.shutdownTimeoutMs / 1000)}s)`);
    void (async () => {
      try {
        const remaining = await api.shutdown(config.shutdownTimeoutMs);
        if (remaining > 0) log(`${String(remaining)} run(s) did not finish in time and will be recovered on next start`);
        await server.close("The daemon is shutting down.");
      } finally {
        process.exit(0);
      }
    })();
  });
}
