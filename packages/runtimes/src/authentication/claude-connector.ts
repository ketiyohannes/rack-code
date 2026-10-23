import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { AsyncQueue } from "@rack/core/shared/async-queue";
import { resolveClaudeCommand } from "./claude-command.js";
import { diagnosticContext, diagnosticExecutable, diagnosticVersion, probeProcess, DiagnosticProcessError } from "./diagnostic-process.js";
import type {
  AccountConnector,
  ConnectAttempt,
  ConnectContext,
  ConnectEvent,
  ConnectedIdentity,
  ProviderDiagnostic,
} from "@rack/core/connections/ports";

/** Variables that would override the account's subscription login. */
const BLOCKED_ENVIRONMENT = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * "Connect Claude account": claude.ai subscription sign-in through the
 * Claude Code CLI that the Agent SDK runs.
 *
 * Flow:
 * 1. Run `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR` set to the
 *    account's private runtime-context directory. Per the Claude Code
 *    authentication docs, the login for that directory is stored there (on
 *    macOS, in a Keychain entry keyed to the directory), which is exactly
 *    where the runtime adapter points the SDK.
 * 2. The CLI opens the sign-in page itself; any URL it prints is forwarded
 *    so the UI can offer it again. If the CLI asks for a pasted code, the UI
 *    shows a code field and `submitCode` writes it to the CLI's stdin.
 * 3. After the CLI exits successfully, `claude auth status --json` (same
 *    directory) reports the identity.
 *
 * The CLI's interactive output is not a stable protocol, so URL and prompt
 * detection is deliberately loose. API-key variables are removed from the
 * environment so they cannot override the subscription login.
 */
export class ClaudeConnector implements AccountConnector {
  readonly providerId = "claude";
  readonly displayName = "Claude";
  readonly existingRuntimeContextId = "local-claude-login";

  constructor(private readonly command = "claude", private readonly probe: typeof probeProcess = probeProcess) {}

  /** Local CLI/status check; never launches interactive login or a model turn.
   * An installation-only check uses disposable config, not the default account.
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
        const environment = claudeEnvironment(scoped);
        executable = diagnosticExecutable(resolveClaudeCommand(this.command, environment), environment, scoped.directory);
        stage = "version";
        const probe = await this.probe(executable, ["--version"], scoped.directory, environment);
        version = diagnosticVersion(probe.stdout);
        if (probe.code !== 0 || version === undefined) return result("failed", "Claude Code did not report a valid version. Update or reinstall the CLI.");
        stage = "startup";
        if (context === undefined) return result("ready", "Claude Code started successfully. Connect an account to sign in.");
        stage = "authentication";
        const status = await this.probe(executable, ["auth", "status", "--json"], scoped.directory, environment);
        const parsed: unknown = JSON.parse(status.stdout);
        if (typeof parsed !== "object" || parsed === null || !("loggedIn" in parsed) || typeof parsed.loggedIn !== "boolean") {
          return result("failed", "Claude Code returned an unreadable account status. Update the CLI and retry.");
        }
        // Claude may exit nonzero for a valid signed-out status. A signed-in
        // result still requires a successful process exit.
        if (parsed.loggedIn && status.code !== 0) return result("failed", "Claude Code account check failed. Retry or reconnect the account.");
        return result(parsed.loggedIn ? "ready" : "failed", parsed.loggedIn
          ? "Claude Code reports a saved sign-in. Subscription and network access were not tested."
          : "Claude Code started, but this account is signed out. Reconnect the account.", parsed.loggedIn ? "signed_in" : "signed_out");
      });
    } catch (error) {
      return result("failed", error instanceof DiagnosticProcessError && error.reason === "timeout"
        ? "Claude Code did not respond within 10 seconds. Close stalled Claude processes and retry."
        : stage === "discovery" ? "Claude Code was not found. Install the native CLI and restart Rack, then retry."
        : `Claude Code ${stage} check failed. Verify the CLI installation, update it if needed, and retry.`);
    }
  }

  /** Read the CLI's own identity without launching login or exporting secrets.
   * The persisted context continues to point at the original native store.
   */
  private existingLogin(context: ConnectContext): ConnectAttempt {
    const events = new AsyncQueue<ConnectEvent>();
    let stopped = false;
    void (async () => {
      try {
        const environment = claudeEnvironment(context);
        const command = resolveClaudeCommand(this.command, environment);
        const result = await this.probe(command, ["auth", "status", "--json"], context.directory, environment);
        if (result.code !== 0) throw new Error("Sign in to Claude Code first with claude auth login, then retry.");
        const identity = parseIdentity(result.stdout);
        if (!stopped) events.push({ type: "completed", identity });
      } catch {
        if (!stopped) events.push({ type: "failed", error: "Could not use the existing Claude login. Install Claude Code and run claude auth login, then retry." });
      } finally { events.complete(); }
    })();
    return { events, submitCode: () => undefined, cancel: async () => { stopped = true; events.complete(); } };
  }

  connect(context: ConnectContext): ConnectAttempt {
    if (context.runtimeContextId === this.existingRuntimeContextId) {
      return this.existingLogin(context);
    }
    const events = new AsyncQueue<ConnectEvent>();
    const environment = claudeEnvironment(context);
    const command = resolveClaudeCommand(this.command, environment);
    const child = spawn(command, ["auth", "login", "--claudeai"], {
      cwd: context.directory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stopped = false;
    let announcedUrl = false;
    let askedForCode = false;
    let output = "";

    const onOutput = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8"));
      // Keep a bounded tail for error messages.
      output = (output + text).slice(-4000);
      const url = text.match(/https:\/\/\S+/)?.[0];
      if (url !== undefined && !announcedUrl) {
        announcedUrl = true;
        // The CLI opens the sign-in page itself; the URL is offered as a fallback.
        events.push({ type: "browser", url: url.replace(/[)\].,]+$/, ""), opened: true });
      }
      if (!askedForCode && /paste|authorization code|enter.*code/i.test(text)) {
        askedForCode = true;
        events.push({ type: "code_required" });
      }
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onOutput);

    child.on("error", (error) => {
      if (!stopped) events.push({ type: "failed", error: `Could not start Claude Code: ${error.message}` });
      events.complete();
    });
    child.on("close", (code) => {
      if (stopped) {
        events.complete();
        return;
      }
      if (code !== 0) {
        events.push({ type: "failed", error: lastLines(output) || `Claude sign-in exited with code ${code ?? "unknown"}.` });
        events.complete();
        return;
      }
      void readIdentity(command, context.directory, environment).then(
        (identity) => events.push({ type: "completed", identity }),
        (error: unknown) => events.push({ type: "failed", error: error instanceof Error ? error.message : String(error) }),
      ).finally(() => events.complete());
    });

    return {
      events,
      submitCode: (code) => {
        if (!child.stdin.destroyed) child.stdin.write(`${code.trim()}\n`);
      },
      cancel: async () => {
        if (stopped) return;
        stopped = true;
        if (child.exitCode === null) child.kill();
      },
    };
  }
}

/** Reads the signed-in identity for one config directory. */
async function readIdentity(
  command: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ConnectedIdentity> {
  const output = await run(command, ["auth", "status", "--json"], directory, environment);
  return parseIdentity(output);
}

/** Only safe identity fields leave the provider boundary. */
function parseIdentity(output: string): ConnectedIdentity {
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error("Claude Code returned an unreadable sign-in status.");
  }
  if (status["loggedIn"] !== true) {
    throw new Error("Claude Code reports that sign-in did not complete.");
  }
  const email = firstString(status, ["email", "emailAddress", "userEmail"]);
  const accountId = firstString(status, ["accountUuid", "accountId", "userId"]) ?? email;
  if (accountId === undefined) {
    throw new Error("Claude Code signed in but did not report an account identity.");
  }
  const plan = firstString(status, ["subscriptionType", "plan", "orgName"]);
  const displayName = firstString(status, ["displayName", "name"]);
  return {
    providerAccountId: accountId,
    ...(email === undefined ? {} : { email }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(plan === undefined ? {} : { plan }),
  };
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(command, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
}

function claudeEnvironment(context: ConnectContext): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...context.environment };
  for (const name of BLOCKED_ENVIRONMENT) delete environment[name];
  environment["CLAUDE_CONFIG_DIR"] = context.directory;
  return environment;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

function lastLines(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" ");
}
