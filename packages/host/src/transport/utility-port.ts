/**
 * Local transport: serves a host over an Electron utility-process port.
 *
 * This is the in-process sibling of `RemoteHostServer`. Both expose the same
 * `HostApi`; they differ in what they can assume. Here both ends ship in one
 * build, so there is no version negotiation, no authorization and no replay
 * buffer — a dropped port means the host died, and main surfaces that as
 * `host_unavailable` rather than trying to resume.
 *
 * What this transport does carry that the remote one cannot is the browser
 * driver. The shared browser is an Electron view owned by main, so the host
 * reaches it by sending `browser_request` upstream and awaiting a matching
 * `browser_response`. Requests are bounded by a timeout: a main process that
 * never answers must not leave a tool call pending for the life of the run.
 *
 * The port is typed structurally rather than imported from Electron, so
 * `@rack/host` stays free of an Electron dependency and this file is
 * exercised by tests with a plain fake.
 */
import type { HostEvent } from "@rack/contracts/events";
import type { CommandResponse, HostInbound, HostOutbound } from "@rack/contracts/transport";
import type { BrowserDriver, BrowserSnapshot } from "@rack/features/browser";

import type { HostEndpoint } from "./connection.js";

/** The slice of Electron's `process.parentPort` this transport uses. */
export interface UtilityParentPort {
  on(event: "message", listener: (message: { readonly data: unknown }) => void): void;
  postMessage(message: HostOutbound): void;
}

/** How long a browser request waits for main before failing the tool call. */
export const DEFAULT_BROWSER_TIMEOUT_MS = 20_000;

export interface UtilityPortTransportOptions {
  readonly browserTimeoutMs?: number;
}

export class UtilityPortTransport {
  private readonly port: UtilityParentPort;
  private readonly browserTimeoutMs: number;
  private readonly browserRequests = new Map<number, (response: CommandResponse<BrowserSnapshot>) => void>();
  private nextBrowserRequest = 1;
  private endpoint: HostEndpoint | undefined;
  /**
   * Requests that arrived before `serve`. Main waits for `ready` before
   * sending any, so this should stay empty; buffering rather than dropping
   * means a future caller that does not wait still gets an answer.
   */
  private readonly early: HostInbound[] = [];

  constructor(port: UtilityParentPort, options: UtilityPortTransportOptions = {}) {
    this.port = port;
    this.browserTimeoutMs = options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
    this.port.on("message", ({ data }) => {
      this.receive(data as HostInbound);
    });
  }

  /**
   * Browser driver backed by main's shared view. Available before the
   * application is composed, because `createApplication` needs it as input.
   */
  readonly browser: BrowserDriver = {
    control: (sessionId, request) =>
      new Promise((resolve, reject) => {
        const id = this.nextBrowserRequest++;
        const timer = setTimeout(() => {
          this.browserRequests.delete(id);
          reject(new Error("The shared browser did not respond."));
        }, this.browserTimeoutMs);
        this.browserRequests.set(id, (response) => {
          clearTimeout(timer);
          if (response.ok) resolve(response.value);
          else reject(new Error(response.error.message));
        });
        this.port.postMessage({ kind: "browser_request", id, sessionId, request });
      }),
  };

  /** Posts a host event upstream. Pass this to `new HostApi(...)`. */
  readonly emit = (event: HostEvent): void => {
    this.port.postMessage({ kind: "event", event });
  };

  /** Starts answering commands with `endpoint`, draining anything buffered. */
  serve(endpoint: HostEndpoint): void {
    this.endpoint = endpoint;
    const pending = this.early.splice(0, this.early.length);
    for (const message of pending) this.receive(message);
  }

  /** Tells main the application is composed and commands may be sent. */
  ready(): void {
    this.port.postMessage({ kind: "ready" });
  }

  private receive(message: HostInbound): void {
    if (message.kind === "browser_response") {
      this.browserRequests.get(message.id)?.(message.response);
      this.browserRequests.delete(message.id);
      return;
    }
    const endpoint = this.endpoint;
    if (endpoint === undefined) {
      this.early.push(message);
      return;
    }
    if (message.kind === "request") {
      void endpoint.dispatch(message.command, message.params).then((response) => {
        this.port.postMessage({ kind: "response", id: message.id, response });
      });
    } else if (message.kind === "shutdown") {
      void endpoint.shutdown(message.timeoutMs).then((remaining) => {
        this.port.postMessage({ kind: "response", id: message.id, response: { ok: true, value: remaining } });
      });
    }
  }
}
