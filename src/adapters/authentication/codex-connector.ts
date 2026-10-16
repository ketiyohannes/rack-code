import { JsonRpcProcess, ProviderRequestTimeoutError, type JsonRpcMessage } from "../runtimes/json-rpc-process.js";
import { AsyncQueue } from "../../core/shared/async-queue.js";
import { resolveCodexCommand } from "../runtimes/codex-command.js";
import { diagnosticContext, diagnosticExecutable, diagnosticVersion, probeProcess, DiagnosticProcessError } from "./diagnostic-process.js";
import type {
  AccountConnector,
  ConnectAttempt,
  ConnectContext,
  ConnectEvent,
  ProviderDiagnostic,
} from "../../core/connections/ports.js";

/**
 * "Connect Codex account": ChatGPT sign-in through the Codex app server.
 *
 * Flow (app-server protocol v2):
 * 1. Start `codex app-server --stdio` with `CODEX_HOME` set to the account's
 *    private runtime-context directory, then `initialize`.
 * 2. `account/login/start` with `{ type: "chatgpt" }` returns `authUrl` and
 *    `loginId`; the app server runs the local OAuth callback listener.
 * 3. The UI opens `authUrl` in the user's browser.
 * 4. `account/login/completed` reports success or an error for `loginId`.
 *    Codex then stores the credential in `CODEX_HOME`; nothing is returned
 *    to us.
 * 5. `account/read` reports the signed-in email and plan, which become the
 *    account identity (Codex exposes no other stable account ID here).
 *
 * Cancelling sends `account/login/cancel` and stops the process.
 */
export class CodexConnector implements AccountConnector {
  readonly providerId = "codex";
  readonly displayName = "Codex";

  constructor(
    private readonly options: {
      readonly command?: string;
      readonly args?: readonly string[];
      readonly createProcess?: typeof JsonRpcProcess.start;
      readonly probeProcess?: typeof probeProcess;
    } = {},
  ) {}

  /** Verify the installed process/protocol without login or model execution.
   * account/read requests no refresh; only its presence becomes UI state.
   * Provider errors and raw process output never enter diagnostic results.
   */
  async diagnose(context?: ConnectContext): Promise<ProviderDiagnostic> {
    let stage: ProviderDiagnostic["stage"] = "discovery";
    let executable: string | undefined;
    let version: string | undefined;
    const result = (status: ProviderDiagnostic["status"], message: string,
      authentication: ProviderDiagnostic["authentication"] = "not_checked"): ProviderDiagnostic => ({
      status, stage, message, authentication, checkedAt: new Date().toISOString(),
      ...(executable === undefined ? {} : { executable }), ...(version === undefined ? {} : { version }),
    });
    try {
      return await diagnosticContext(context, async (scoped) => {
        const environment = { ...process.env, ...scoped.environment, CODEX_HOME: scoped.directory };
        executable = diagnosticExecutable(resolveCodexCommand(this.options.command, { environment }), environment, scoped.directory);
        stage = "version";
        const probe = await (this.options.probeProcess ?? probeProcess)(executable, ["--version"], scoped.directory, environment);
        version = diagnosticVersion(probe.stdout);
        if (probe.code !== 0 || version === undefined) return result("failed", "Codex did not report a valid version. Update or reinstall Codex CLI.");
        stage = "startup";
        const child = (this.options.createProcess ?? JsonRpcProcess.start.bind(JsonRpcProcess))(executable, this.options.args ?? ["app-server", "--stdio"], { cwd: scoped.directory, environment });
        try {
          await child.request("initialize", { clientInfo: { name: "rack-diagnostics", version: "1.0.0" }, capabilities: {} }, 10_000);
          child.notify("initialized", {});
          if (context === undefined) return result("ready", "Codex started successfully. Connect an account to sign in.");
          stage = "authentication";
          const response = await child.request("account/read", { refreshToken: false }, 10_000);
          const account = recordAt(response, "account");
          if (account !== null && stringAt(account, "type") !== "chatgpt") return result("failed", "Codex did not report a ChatGPT account status. Reconnect the subscription account or update Codex CLI.");
          const signedIn = account !== null;
          return result(signedIn ? "ready" : "failed", signedIn
            ? "Codex started and reports a saved sign-in. Subscription and network access were not tested."
            : "Codex started, but this account is signed out. Reconnect the account.", signedIn ? "signed_in" : "signed_out");
        } finally { await child.close(); }
      });
    } catch (error) {
      return result("failed", (error instanceof DiagnosticProcessError && error.reason === "timeout") || error instanceof ProviderRequestTimeoutError
        ? "Codex did not respond within 10 seconds. Close stalled Codex processes and retry."
        : stage === "discovery" ? "Codex CLI was not found. Install it and restart Rack, then retry."
        : `Codex ${stage} check failed. Verify the CLI installation, update it if needed, and retry.`);
    }
  }

  connect(context: ConnectContext): ConnectAttempt {
    const events = new AsyncQueue<ConnectEvent>();
    const start = this.options.createProcess ?? JsonRpcProcess.start.bind(JsonRpcProcess);
    const environment = { ...process.env, ...context.environment, CODEX_HOME: context.directory };
    const command = this.options.createProcess === undefined
      ? resolveCodexCommand(this.options.command, { environment })
      : this.options.command ?? "codex";
    const child = start(command, this.options.args ?? ["app-server", "--stdio"], {
      cwd: context.directory,
      environment,
    });
    let loginId: string | undefined;
    let stopped = false;

    const run = async () => {
      try {
        await child.request("initialize", {
          clientInfo: { name: "thinking-and-code", title: "Thinking and Code", version: "0.1.0" },
          capabilities: {},
        }, 10_000);
        child.notify("initialized", {});
        const started = await child.request("account/login/start", { type: "chatgpt" }, 10_000);
        loginId = stringAt(started, "loginId");
        const authUrl = stringAt(started, "authUrl");
        if (loginId === undefined || authUrl === undefined) {
          throw new Error("Codex did not return a sign-in URL.");
        }
        // The app server does not open a browser; the client must.
        events.push({ type: "browser", url: authUrl, opened: false });

        // Wait for the completion notification for this login.
        for (;;) {
          const next = await child.nextMessage();
          if (next.done) throw new Error("Codex stopped before sign-in completed.");
          const message: JsonRpcMessage = next.value;
          if (message.method !== "account/login/completed") continue;
          const completedId = stringAt(message.params, "loginId");
          if (completedId !== undefined && completedId !== loginId) continue;
          if (booleanAt(message.params, "success") !== true) {
            throw new Error(stringAt(message.params, "error") ?? "Codex sign-in failed.");
          }
          break;
        }

        const account = recordAt(await child.request("account/read", {}, 10_000), "account");
        const email = stringAt(account, "email");
        if (email === undefined) {
          throw new Error("Codex signed in but did not report an account email.");
        }
        const plan = stringAt(account, "planType");
        events.push({
          type: "completed",
          identity: { providerAccountId: email, email, ...(plan === undefined ? {} : { plan }) },
        });
      } catch (error) {
        if (!stopped) {
          events.push({ type: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        events.complete();
      }
    };
    void run();

    return {
      events,
      submitCode: () => {
        // The ChatGPT browser flow completes through Codex's own callback
        // listener; there is no code to paste.
      },
      cancel: async () => {
        if (stopped) return;
        stopped = true;
        if (loginId !== undefined) {
          await child.request("account/login/cancel", { loginId }, 2_000).catch(() => undefined);
        }
        await child.close();
        events.complete();
      },
    };
  }
}

function recordAt(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const field = recordAt(value, key);
  return typeof field === "string" && field !== "" ? field : undefined;
}

function booleanAt(value: unknown, key: string): boolean | undefined {
  const field = recordAt(value, key);
  return typeof field === "boolean" ? field : undefined;
}
