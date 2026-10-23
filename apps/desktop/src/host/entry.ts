/**
 * Execution host entry point, launched by Electron main as a utility process.
 *
 * The host owns the composed application (accounts, sessions, execution,
 * runtime adapters, persistence) and all in-flight runs. Running it outside
 * the main process keeps provider processes and JSON persistence off the
 * window event loop, and gives the future background mode a process whose
 * lifetime can be decoupled from windows without moving application code.
 *
 * Everything below the port is shared with `apps/daemon`:
 * `UtilityPortTransport` implements the wire protocol in
 * `@rack/contracts/transport` (ready, request/response by ID, events,
 * bounded shutdown, and the browser round-trip to main), and `startHost`
 * composes the application and recovers prior-process records. This file is
 * only the Electron-specific glue: find `process.parentPort`, read the data
 * directory argument, and announce readiness.
 *
 * The data directory may be overridden with `--data-directory=<path>`;
 * otherwise `createApplication`'s default is used, so the desktop app and
 * headless embedders share the same local records.
 */
import { UtilityPortTransport, startHost, type UtilityParentPort } from "@rack/host";

const parentPort = (process as unknown as { parentPort?: UtilityParentPort }).parentPort;
if (parentPort === undefined) {
  throw new Error("The execution host must be started as an Electron utility process.");
}

const transport = new UtilityPortTransport(parentPort);

const dataDirectory = process.argv
  .find((argument) => argument.startsWith("--data-directory="))
  ?.slice("--data-directory=".length);

const { api } = await startHost(
  { ...(dataDirectory === undefined ? {} : { dataDirectory }), browser: transport.browser },
  transport.emit,
);

transport.serve(api);
// Posted only after recovery finished, so main never exposes stale run
// statuses or writer locks held by the previous process.
transport.ready();
