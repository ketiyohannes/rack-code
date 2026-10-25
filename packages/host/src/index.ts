/**
 * Public entry point of `@rack/host`: application composition and the
 * transport-independent command surface. A process that hosts Rack (the
 * Electron utility process and the daemon) calls `createApplication()` and
 * wraps the result in a `HostApi`. How commands and events travel is left to
 * `./transport`, which carries the two links Rack serves today: the Electron
 * utility port and a remote, resumable, token-authorized connection.
 */
// Re-exported so processes that start a host agree on the record location
// without depending on the adapter layer directly.
export { adoptLegacyDataDirectory, defaultDataDirectory } from "@rack/node-adapters/storage/data-directory";
export { createApplication } from "./composition/application.js";
export type { Application, CreateApplicationOptions } from "./composition/application.js";
export { HostApi } from "./host-api.js";
export { startHost } from "./bootstrap.js";
export type { StartedHost } from "./bootstrap.js";
export { ActiveRuns } from "./active-runs.js";
export * from "./transport/index.js";
