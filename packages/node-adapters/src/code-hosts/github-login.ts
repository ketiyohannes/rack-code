/**
 * Browser sign-in for GitHub accounts, delegated to `gh auth login --web`.
 *
 * Why the GitHub CLI instead of a Rack OAuth app:
 * - gh already owns the credential store Rack reads (`gh auth status` and
 *   `gh auth token --user`). Signing in through it makes the new identity
 *   persistent across restarts without Rack adding its own secret vault.
 * - gh supports GitHub Enterprise hosts with the same device flow, which a
 *   single Rack OAuth client ID could not.
 * - Rack never sees or handles a token during sign-in.
 *
 * Flow: `begin` spawns gh without a TTY. gh then prints a one-time device
 * code and the verification URL to stderr instead of prompting. Those are
 * parsed and returned so the UI can show the code and open the page. gh keeps
 * polling GitHub until the user authorizes, the code expires, or the process
 * is cancelled. `finish` resolves with that outcome.
 *
 * Failure behavior: gh output is never forwarded verbatim. Only a short final
 * line is surfaced, with anything that looks like a GitHub token redacted.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/** The subset of a child process the login flow needs; tests substitute an emitter. */
export interface LoginProcess {
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  kill(): boolean;
}
export type SpawnLogin = (args: readonly string[], env: NodeJS.ProcessEnv) => LoginProcess;

export interface BrowserLoginStart { readonly loginId: string; readonly host: string; readonly userCode: string; readonly verificationUrl: string }
/** `login` is the GitHub username gh reported, when it could be parsed. */
export type BrowserLoginOutcome =
  | { readonly status: "completed"; readonly host: string; readonly login?: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "cancelled" };

const spawnGh: SpawnLogin = (args, env) => spawn("gh", [...args], { env, stdio: ["ignore", "pipe", "pipe"] });

/** gh prints e.g. "! First copy your one-time code: ABCD-1234". */
const CODE_PATTERN = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i;
const URL_PATTERN = /(https:\/\/\S+)/;
/** gh prints "✓ Logged in as <login>" on success. */
const LOGIN_PATTERN = /Logged in as\s+([\w-]+)/;
const TOKEN_PATTERN = /\b(?:gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g;
/** The device code must appear promptly; otherwise gh is waiting on something else. */
const START_TIMEOUT_MS = 20_000;
/** GitHub device codes expire after 15 minutes; never keep gh running longer. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** Bounded output capture: gh prints a few lines, never megabytes. */
const MAX_OUTPUT = 64 * 1024;

interface PendingLogin { readonly process: LoginProcess; readonly done: Promise<BrowserLoginOutcome>; readonly state: { cancelled: boolean } }

export class GitHubBrowserLogin {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly hostLogins = new Map<string, string>();

  constructor(private readonly environment: () => NodeJS.ProcessEnv, private readonly run: SpawnLogin = spawnGh) {}

  /**
   * Starts a device-flow sign-in for `host` and resolves once gh has printed
   * the code and URL. A second sign-in for the same host replaces the first,
   * because GitHub would otherwise accept either code and the UI shows one.
   * Rejects when gh is missing, exits early, or prints no code in time.
   */
  async begin(host: string): Promise<BrowserLoginStart> {
    const previous = this.hostLogins.get(host);
    if (previous) this.cancel(previous);
    const loginId = randomUUID();
    const child = this.run(["auth", "login", "--web", "--hostname", host], this.environment());
    let output = "";
    let settleStart: ((value: BrowserLoginStart | Error) => void) | undefined;
    const started = new Promise<BrowserLoginStart | Error>((resolve) => { settleStart = resolve; });
    const read = (chunk: Buffer | string) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
      const code = CODE_PATTERN.exec(output)?.[1];
      // The verification page is the only URL gh prints before authorization.
      const url = URL_PATTERN.exec(output)?.[1];
      if (code && url) {
        const verificationUrl = verifiedUrl(url, host);
        settleStart?.(verificationUrl ? { loginId, host, userCode: code.toUpperCase(), verificationUrl } : new Error("GitHub CLI returned an unexpected sign-in address."));
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const startTimer = setTimeout(() => settleStart?.(new Error("GitHub CLI did not start a browser sign-in. Check that gh is up to date.")), START_TIMEOUT_MS);
    const loginTimer = setTimeout(() => { child.kill(); }, LOGIN_TIMEOUT_MS);
    loginTimer.unref?.();
    // `cancelled` is read when gh exits, so cancellation is distinguishable from expiry.
    const state = { cancelled: false };
    const done = new Promise<BrowserLoginOutcome>((resolve) => {
      child.once("error", (error) => {
        clearTimeout(loginTimer);
        settleStart?.(new Error(error.code === "ENOENT"
          ? "Browser sign-in uses the GitHub CLI. Install gh from https://cli.github.com, then try again."
          : "GitHub CLI could not be started."));
        resolve({ status: "failed", error: "GitHub CLI could not be started." });
      });
      child.once("exit", (code) => {
        clearTimeout(loginTimer);
        // A no-op when the code was already shown; otherwise the start request fails with gh's reason.
        settleStart?.(new Error(failure(output) ?? "GitHub CLI stopped before showing a sign-in code."));
        if (state.cancelled) resolve({ status: "cancelled" });
        else if (code === 0) {
          const login = LOGIN_PATTERN.exec(output)?.[1];
          resolve(login ? { status: "completed", host, login } : { status: "completed", host });
        } else resolve({ status: "failed", error: failure(output) ?? "The sign-in code expired or was declined. Start again." });
      });
    });
    const entry: PendingLogin = { process: child, done, state };
    const result = await started;
    clearTimeout(startTimer);
    if (result instanceof Error) { state.cancelled = true; child.kill(); throw result; }
    this.pending.set(loginId, entry);
    this.hostLogins.set(host, loginId);
    // Release bookkeeping once gh exits, whether or not the UI ever asks for the outcome.
    void entry.done.then(() => {
      if (this.hostLogins.get(host) === loginId) this.hostLogins.delete(host);
      setTimeout(() => this.pending.delete(loginId), 60_000).unref?.();
    });
    return result;
  }

  /** Resolves when the user authorizes, declines, the code expires, or the login is cancelled. */
  async finish(loginId: string): Promise<BrowserLoginOutcome> {
    const entry = this.pending.get(loginId);
    if (!entry) return { status: "failed", error: "This sign-in is no longer active. Start again." };
    return entry.done;
  }

  /** Stops a waiting gh process. Unknown or finished logins are ignored. */
  cancel(loginId: string): void {
    const entry = this.pending.get(loginId);
    if (!entry) return;
    entry.state.cancelled = true;
    entry.process.kill();
  }

  /** Stops every waiting sign-in; used when the host shuts down. */
  cancelAll(): void { for (const id of this.pending.keys()) this.cancel(id); }
}

/** Only an https page on the requested host may be opened in the user's browser. */
function verifiedUrl(raw: string, host: string): string | undefined {
  try {
    const url = new URL(raw.replace(/[).,]+$/, ""));
    return url.protocol === "https:" && url.hostname.toLowerCase() === host.toLowerCase() ? url.toString() : undefined;
  } catch { return undefined; }
}

/** Last meaningful gh line, trimmed and token-redacted, or undefined when gh printed nothing useful. */
function failure(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.replace(/^[!✓X\s]+/, "").trim())
    .filter((line) => line && !CODE_PATTERN.test(line) && !/Open this URL|Press Enter/i.test(line));
  const last = lines.at(-1);
  return last ? last.replace(TOKEN_PATTERN, "[redacted]").slice(0, 240) : undefined;
}
