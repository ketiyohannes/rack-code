/**
 * Electron-main client for the execution host utility process.
 *
 * Responsibilities:
 * - fork the host bundle with `utilityProcess.fork`;
 * - correlate request/response pairs by numeric ID;
 * - forward host events to a listener (main broadcasts them to windows);
 * - report host exit so pending requests fail fast with `host_unavailable`
 *   and the renderer can show that the host is offline.
 *
 * The host is not restarted automatically after a crash. Its in-flight runs
 * died with it and their records may still say `running`; automatic restart
 * and stale-run recovery need a defined recovery policy first.
 */
import { utilityProcess, type UtilityProcess } from "electron";

import type { CommandResponse, HostInbound, HostOutbound } from "../../contracts/desktop/transport.js";
import type { HostEvent } from "../../contracts/desktop/events.js";
import type { HostCommand } from "../../contracts/desktop/commands.js";

export interface HostProcessOptions {
  /** Absolute path of the bundled host entry module. */
  readonly modulePath: string;
  readonly args?: readonly string[];
  /** Environment for the host process; defaults to main's environment. */
  readonly env?: NodeJS.ProcessEnv;
  readonly onEvent: (event: HostEvent) => void;
  readonly onExit: (code: number) => void;
}

type Pending = (response: CommandResponse) => void;

export class HostProcess {
  private readonly child: UtilityProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private exited = false;
  /** Resolves when the host posts `ready`, i.e. the application is composed. */
  readonly ready: Promise<void>;

  constructor(options: HostProcessOptions) {
    this.child = utilityProcess.fork(options.modulePath, [...(options.args ?? [])], {
      serviceName: "Execution Host",
      ...(options.env === undefined ? {} : { env: options.env }),
      // Inherit stdio so host logs and crashes are visible in the terminal
      // that launched the app during development.
      stdio: "inherit",
    });
    let markReady: () => void = () => undefined;
    this.ready = new Promise((resolve) => {
      markReady = resolve;
    });

    this.child.on("message", (message: HostOutbound) => {
      if (message.kind === "ready") {
        markReady();
      } else if (message.kind === "response") {
        const resolve = this.pending.get(message.id);
        this.pending.delete(message.id);
        resolve?.(message.response);
      } else if (message.kind === "event") {
        options.onEvent(message.event);
      }
    });

    this.child.on("exit", (code) => {
      this.exited = true;
      for (const resolve of this.pending.values()) {
        resolve(unavailable("The execution host exited before answering."));
      }
      this.pending.clear();
      options.onExit(code);
    });
  }

  get isRunning(): boolean {
    return !this.exited;
  }

  /** Sends a command; parameters are validated again inside the host. */
  request(command: HostCommand, params: unknown): Promise<CommandResponse> {
    return this.send((id) => ({ kind: "request", id, command, params }));
  }

  /**
   * Asks the host to cancel active runs and wait up to `timeoutMs`. Resolves
   * with the number of runs still active, or 0 if the host already exited.
   */
  async shutdown(timeoutMs: number): Promise<number> {
    const response = await this.send((id) => ({ kind: "shutdown", id, timeoutMs }));
    return response.ok ? Number(response.value) : 0;
  }

  kill(): void {
    if (!this.exited) {
      this.child.kill();
    }
  }

  private send(build: (id: number) => HostInbound): Promise<CommandResponse> {
    if (this.exited) {
      return Promise.resolve(unavailable("The execution host is not running."));
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.postMessage(build(id));
    });
  }
}

function unavailable(message: string): CommandResponse {
  return { ok: false, error: { code: "host_unavailable", name: "HostUnavailableError", message } };
}
