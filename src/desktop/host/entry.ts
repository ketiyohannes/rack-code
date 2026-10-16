/**
 * Execution host entry point, launched by Electron main as a utility process.
 *
 * The host owns the composed application (accounts, sessions, execution,
 * runtime adapters, persistence) and all in-flight runs. Running it outside
 * the main process keeps provider processes and JSON persistence off the
 * window event loop, and gives the future background mode a process whose
 * lifetime can be decoupled from windows without moving application code.
 *
 * Protocol (see `contracts/desktop/transport.ts`):
 * - on start, the host posts `{ kind: "ready" }`;
 * - each `request` is answered with exactly one `response` carrying the same
 *   ID; requests are handled concurrently;
 * - host events are posted as `{ kind: "event" }` at any time;
 * - `shutdown` cancels active runs, waits up to `timeoutMs`, replies, and
 *   leaves process termination to main.
 *
 * The data directory may be overridden with `--data-directory=<path>`;
 * otherwise `createApplication`'s default is used, so the desktop app and
 * headless embedders share the same local records.
 */
import { createApplication } from "../../composition/application.js";
import type { HostInbound, HostOutbound } from "../../contracts/desktop/transport.js";
import { HostApi } from "./host-api.js";
import type { BrowserDriver, BrowserSnapshot } from "../../features/browser/index.js";

/** The subset of Electron's `process.parentPort` that the host uses. */
interface ParentPort {
  on(event: "message", listener: (message: { readonly data: unknown }) => void): void;
  postMessage(message: HostOutbound): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (parentPort === undefined) {
  throw new Error("The execution host must be started as an Electron utility process.");
}
const port: ParentPort = parentPort;
let nextBrowserRequest = 1;
const browserRequests = new Map<number, (response: import("../../contracts/desktop/transport.js").CommandResponse<BrowserSnapshot>) => void>();
const browser: BrowserDriver = { control: (sessionId, request) => new Promise((resolve, reject) => {
  const id = nextBrowserRequest++;
  const timer = setTimeout(() => { browserRequests.delete(id); reject(new Error("The shared browser did not respond.")); }, 20_000);
  browserRequests.set(id, (response) => { clearTimeout(timer); if (response.ok) resolve(response.value); else reject(new Error(response.error.message)); });
  port.postMessage({ kind: "browser_request", id, sessionId, request });
}) };

const dataDirectoryArgument = process.argv
  .find((argument) => argument.startsWith("--data-directory="))
  ?.slice("--data-directory=".length);

const application = createApplication(
  { ...(dataDirectoryArgument === undefined ? {} : { dataDirectory: dataDirectoryArgument }), browser },
);
const api = new HostApi(application, (event) => port.postMessage({ kind: "event", event }));
// Existing projects start recording without needing a session/import action.
// Failures are optional-feature failures and cannot prevent host readiness.
void application.execution.initialize().then(() => application.timeline?.startProjectTracking()).catch(() => {});

port.on("message", ({ data }) => {
  const message = data as HostInbound;
  if (message.kind === "browser_response") {
    browserRequests.get(message.id)?.(message.response);
    browserRequests.delete(message.id);
  } else if (message.kind === "request") {
    void api.dispatch(message.command, message.params).then((response) => {
      port.postMessage({ kind: "response", id: message.id, response });
    });
  } else if (message.kind === "shutdown") {
    void api.shutdown(message.timeoutMs).then((remaining) => {
      port.postMessage({ kind: "response", id: message.id, response: { ok: true, value: remaining } });
    });
  }
});

// Main must not expose stale run statuses or writer locks during recovery.
await application.execution.initialize();
port.postMessage({ kind: "ready" });
