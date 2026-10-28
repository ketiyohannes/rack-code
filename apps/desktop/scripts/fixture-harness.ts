/**
 * Shared plumbing for the native Electron checks (`verify-*.ts`).
 *
 * The checks drive a real window from the main process, so the ways they can
 * fail are easy to lose: a page-side exception surfaces only as Electron's
 * opaque "Script failed to execute", a renderer crash or a hung
 * `executeJavaScript` stalls until a watchdog fires, and `app.exit()` right
 * after `console.error()` can drop the message because stdout and stderr are
 * asynchronous when they are pipes. This harness makes every outcome
 * readable:
 *
 * - every exit goes through {@link finish}, which waits for stdout and stderr
 *   to drain before quitting;
 * - a failure report names the step reached, the last wait and its last
 *   result or page error, collected console errors, and any check-specific
 *   diagnostics, before cleanup runs;
 * - the watchdog stays armed through cleanup, and a cleanup error is reported
 *   in addition to the original failure, never instead of it;
 * - renderer crashes, hangs, preload errors, child-process crashes and
 *   unhandled rejections fail the check with a reason;
 * - {@link FixtureCheck.reloadAndWait} returns only once the new document has
 *   loaded, so conditions after a reload are evaluated on the new page.
 *
 * Importing this module also keeps the check window rendering when it is not
 * in front. Rack applies state on animation frames (`store.ts`), and Chromium
 * stops those for a window macOS reports as covered by another app's window
 * (or on another Space), so a check started while the user works elsewhere
 * would otherwise freeze mid-run. The switches below are Chromium's
 * test-only opt-outs (the same ones Puppeteer passes by default); they apply
 * to the check process only, never to the shipped app.
 *
 * Environment overrides, for proving the failure paths:
 * - `RACK_CHECK_WATCHDOG_MS` replaces the overall time limit;
 * - `RACK_CHECK_UNTIL_MS` replaces the timeout of every wait;
 * - `RACK_CHECK_EVENT_DELAY_MS` delays everything the host sends the
 *   renderer, events and command replies alike (see {@link rendererLink}),
 *   which widens main-process/renderer races.
 */
import { app, type BrowserWindow } from "electron";
import { writeFile } from "node:fs/promises";

for (const flag of ["disable-backgrounding-occluded-windows", "disable-renderer-backgrounding", "disable-background-timer-throttling"]) {
  app.commandLine.appendSwitch(flag);
}

const POLL_MS = 20;
const SCRIPT_TIMEOUT_MS = 10_000;
const DIAGNOSTIC_TIMEOUT_MS = 3_000;
const FLUSH_TIMEOUT_MS = 2_000;

function envMilliseconds(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of milliseconds, got '${raw}'.`);
  return value;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return String(error);
}

function preview(value: unknown): string {
  let text: string;
  try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message())), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Whether `source` parses as one expression. Only parsed here, never run:
 * page scripts are either an expression (whose value is returned) or a
 * statement list run for its effects.
 */
function isExpression(source: string): boolean {
  try { new Function(`return (\n${source}\n);`); return true; } catch { return false; }
}

let finishing = false;

/**
 * Writes `message` (stdout for code 0, stderr otherwise) and exits only once
 * both streams have flushed. A safety timer forces the exit if a stream never
 * reports back. Later calls are ignored: the first outcome wins.
 */
export function finish(code: number, message?: string): void {
  if (finishing) return;
  finishing = true;
  process.exitCode = code;
  const force = setTimeout(() => app.exit(code), FLUSH_TIMEOUT_MS);
  const exit = () => { clearTimeout(force); app.exit(code); };
  const text = message === undefined || message === "" ? "" : message.endsWith("\n") ? message : `${message}\n`;
  (code === 0 ? process.stdout : process.stderr).write(text, () => {
    // Writes complete in order, so an empty write's callback on each stream
    // means everything written before it has been handed to the OS.
    process.stdout.write("", () => process.stderr.write("", exit));
  });
}

/** Writes a line to stderr without exiting. */
function report(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Simulates a slow host-to-renderer link: with `RACK_CHECK_EVENT_DELAY_MS`
 * set, every event and every command reply reaches the renderer that much
 * later. Both are delayed by the same amount from the moment the host
 * produces them, so they keep the order Electron's IPC guarantees (a reply
 * never overtakes an event emitted before it); only the renderer lags behind
 * the main process. Without the variable both wrappers are identity.
 */
export const rendererLink = {
  events<T>(send: (event: T) => void): (event: T) => void {
    const delay = envMilliseconds("RACK_CHECK_EVENT_DELAY_MS") ?? 0;
    if (delay === 0) return send;
    return (event) => { setTimeout(() => send(event), delay); };
  },
  replies<A extends unknown[], R>(handle: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    const delay = envMilliseconds("RACK_CHECK_EVENT_DELAY_MS") ?? 0;
    if (delay === 0) return handle;
    const later = () => new Promise<void>((done) => setTimeout(done, delay));
    return async (...args) => {
      try {
        const result = await handle(...args);
        await later();
        return result;
      } catch (error) {
        await later();
        throw error;
      }
    };
  },
};

interface WaitState { readonly source: string; result?: string | undefined; error?: string | undefined }

interface PageResult { readonly ok: boolean; readonly value?: unknown; readonly error?: string }

export interface FixtureCheckOptions {
  /** Shown in every failure report, e.g. "Message queue check". */
  readonly name: string;
  /**
   * Overall time limit, including cleanup. `RACK_CHECK_WATCHDOG_MS` overrides
   * it; `Infinity` disables it (interactive demos).
   */
  readonly watchdogMs?: number;
  /** Default timeout for {@link FixtureCheck.until}. */
  readonly untilMs?: number;
  /** Where to save a screenshot of the window when the check fails. */
  readonly failureScreenshot?: string;
}

/**
 * One native check run. Create it at module load, call {@link run} with the
 * check body, and {@link attach} the window as soon as it exists.
 */
export class FixtureCheck {
  readonly consoleErrors: string[] = [];
  private window: BrowserWindow | undefined;
  private currentStep = "starting";
  private lastWait: WaitState | undefined;
  private readonly diagnostics: { label: string; read: () => unknown }[] = [];
  private readonly cleanups: (() => unknown)[] = [];
  private readonly cleanupErrors: string[] = [];
  private readonly watchdogMs: number;
  private readonly untilMs: number;
  private readonly untilOverride: number | undefined;
  private failing = false;
  private closing = false;
  private watchdog: NodeJS.Timeout | undefined;

  constructor(private readonly options: FixtureCheckOptions) {
    this.watchdogMs = envMilliseconds("RACK_CHECK_WATCHDOG_MS") ?? options.watchdogMs ?? 90_000;
    this.untilOverride = envMilliseconds("RACK_CHECK_UNTIL_MS");
    this.untilMs = options.untilMs ?? 15_000;
  }

  /** Records the step the check has reached, for failure reports. */
  step(name: string): void { this.currentStep = name; }

  /** Adds a labelled, best-effort reading to failure reports. */
  diagnose(label: string, read: () => unknown): void { this.diagnostics.push({ label, read }); }

  /** Registers cleanup; callbacks run in reverse order, under the watchdog. */
  onCleanup(cleanup: () => unknown): void { this.cleanups.push(cleanup); }

  /** Collects console errors and fails the check if the window's renderer dies or hangs. */
  attach(window: BrowserWindow): void {
    this.window = window;
    const contents = window.webContents;
    contents.on("console-message", (details) => { if (details.level === "error") this.consoleErrors.push(details.message); });
    // Closing the window (as an interactive demo does) ends its renderer normally.
    let closed = false;
    window.once("close", () => { closed = true; });
    contents.on("render-process-gone", (_event, details) => { if (!closed) this.fatal(`The renderer process is gone: ${details.reason} (exit code ${details.exitCode}).`, "process"); });
    contents.on("unresponsive", () => { if (!closed) this.fatal("The renderer stopped responding.", "process"); });
    contents.on("preload-error", (_event, path, error) => this.fatal(`The preload script ${path} failed: ${describe(error)}`));
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => { if (isMainFrame) this.fatal(`The page failed to load (${code} ${description}): ${url}`); });
  }

  /**
   * Runs `body` (which returns the PASS line), then cleanup, then exits
   * through {@link finish}. Call it once, at module level.
   */
  run(body: () => Promise<string>): void {
    process.on("unhandledRejection", (reason) => this.fatal(`Unhandled promise rejection: ${describe(reason)}`));
    process.on("uncaughtException", (error) => this.fatal(`Uncaught exception: ${describe(error)}`));
    app.on("child-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit") this.fatal(`A ${details.type} child process is gone: ${details.reason} (exit code ${details.exitCode}).`, "process");
    });
    if (Number.isFinite(this.watchdogMs)) this.watchdog = setTimeout(() => this.onWatchdog(), this.watchdogMs);
    void (async () => {
      let pass: string;
      try {
        await app.whenReady();
        pass = await body();
      } catch (error) {
        await this.fail(error);
        return;
      }
      if (this.failing) return;
      this.closing = true;
      await this.cleanup();
      if (this.cleanupErrors.length > 0) {
        finish(1, `${this.options.name} passed, but cleanup failed:\n${this.cleanupErrors.join("\n")}`);
        return;
      }
      this.disarm();
      finish(0, pass);
    })();
  }

  /**
   * Runs `source` in the page and returns its value (statement lists return
   * undefined). Page exceptions keep their message and stack.
   */
  async js<T>(source: string, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<T> {
    const window = this.requireWindow();
    // Wrapping keeps the page's own error; Electron would otherwise report only
    // "Script failed to execute".
    const body = isExpression(source) ? `(\n${source}\n)` : `{\n${source}\n}`;
    const wrapped = `Promise.resolve().then(() => ${body}).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: error instanceof Error ? (error.stack || error.message) : String(error) }))`;
    const result = await withTimeout(window.webContents.executeJavaScript(wrapped) as Promise<PageResult>, timeoutMs,
      () => `The page did not answer within ${timeoutMs}ms (step: ${this.currentStep}): ${source}`);
    if (!result.ok) throw new Error(`Page script failed (step: ${this.currentStep}): ${result.error}\nSource: ${source}`);
    return result.value as T;
  }

  /**
   * Polls a page expression until it is truthy. Page errors (for example a
   * selector that does not match yet) keep the wait going; on timeout the
   * last result or error is reported.
   */
  async until(source: string, timeoutMs = this.untilMs): Promise<void> {
    await this.poll(source, () => this.js<unknown>(source, SCRIPT_TIMEOUT_MS), timeoutMs);
  }

  /** Polls a main-process condition until it is truthy, with the same reporting as {@link until}. */
  async untilHost(description: string, check: () => unknown, timeoutMs = this.untilMs): Promise<void> {
    await this.poll(description, async () => check(), timeoutMs);
  }

  /** Reloads the window and returns once the new document is loaded and running. */
  async reloadAndWait(timeoutMs = this.untilMs): Promise<void> {
    const contents = this.requireWindow().webContents;
    await this.js("(window.__rackStaleDocument = true)");
    const loaded = new Promise<void>((resolve, reject) => {
      const onLoad = () => { contents.off("did-fail-load", onFail); resolve(); };
      const onFail = (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean) => {
        if (!isMainFrame) return;
        contents.off("did-finish-load", onLoad);
        reject(new Error(`Reload failed (${code} ${description}): ${url}`));
      };
      contents.once("did-finish-load", onLoad);
      contents.on("did-fail-load", onFail);
    });
    this.lastWait = { source: "the reloaded page to finish loading" };
    contents.reload();
    await withTimeout(loaded, this.effectiveTimeout(timeoutMs), () => `The reload did not finish loading (step: ${this.currentStep}).`);
    await this.until("window.__rackStaleDocument !== true", timeoutMs);
  }

  private effectiveTimeout(timeoutMs: number): number { return this.untilOverride ?? timeoutMs; }

  private async poll(source: string, read: () => Promise<unknown>, timeoutMs: number): Promise<void> {
    const limit = this.effectiveTimeout(timeoutMs);
    const end = Date.now() + limit;
    const wait: WaitState = { source };
    this.lastWait = wait;
    for (;;) {
      try {
        const value = await read();
        if (value) return;
        wait.result = preview(value); wait.error = undefined;
      } catch (error) {
        wait.error = error instanceof Error ? error.message : String(error); wait.result = undefined;
      }
      if (Date.now() >= end) {
        const last = wait.error !== undefined ? `Last error: ${wait.error}` : `Last result: ${wait.result}`;
        throw new Error(`Timed out after ${limit}ms (step: ${this.currentStep}) waiting for: ${source}\n${last}`);
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  }

  private requireWindow(): BrowserWindow {
    if (this.window === undefined || this.window.isDestroyed()) throw new Error(`No live window (step: ${this.currentStep}).`);
    if (this.window.webContents.isCrashed()) throw new Error(`The renderer has crashed (step: ${this.currentStep}).`);
    return this.window;
  }

  private disarm(): void { if (this.watchdog !== undefined) clearTimeout(this.watchdog); this.watchdog = undefined; }

  private onWatchdog(): void {
    if (this.failing || this.closing) {
      // Cleanup (after a pass or a failure) is the thing that hung.
      finish(1, `${this.options.name}: cleanup did not finish within the ${this.watchdogMs}ms time limit (step: ${this.currentStep}).`);
      return;
    }
    const wait = this.lastWait === undefined ? "" : `\nLast wait: ${this.lastWait.source}\n${this.lastWait.error !== undefined ? `Last error: ${this.lastWait.error}` : `Last result: ${this.lastWait.result ?? "(none yet)"}`}`;
    void this.fail(new Error(`Timed out: the check did not finish within ${this.watchdogMs}ms.${wait}`));
  }

  /**
   * An event outside the check body. Process exits and hangs are expected
   * once cleanup closes the window, so only errors count after that point.
   */
  private fatal(reason: string, kind: "process" | "error" = "error"): void {
    if (finishing) return;
    if (this.closing && kind === "process") return;
    if (this.closing || this.failing) { this.cleanupErrors.push(reason); report(`${this.options.name}: ${reason}`); return; }
    void this.fail(new Error(reason));
  }

  private async fail(error: unknown): Promise<void> {
    if (this.failing || finishing) return;
    this.failing = true;
    report(`FAIL: ${this.options.name} failed at step: ${this.currentStep}\n${describe(error)}`);
    report(await this.readDiagnostics());
    this.closing = true;
    await this.cleanup();
    const cleanup = this.cleanupErrors.length > 0 ? `\nAlso, cleanup failed:\n${this.cleanupErrors.join("\n")}` : "";
    finish(1, `FAIL: ${this.options.name} (step: ${this.currentStep})${cleanup}`);
  }

  private async readDiagnostics(): Promise<string> {
    const lines: string[] = ["Diagnostics:"];
    if (this.lastWait !== undefined) {
      lines.push(`  last wait: ${this.lastWait.source}`);
      lines.push(`    ${this.lastWait.error !== undefined ? `error: ${this.lastWait.error}` : `result: ${this.lastWait.result ?? "(none yet)"}`}`);
    }
    lines.push(`  console errors: ${this.consoleErrors.length === 0 ? "none" : `\n    ${this.consoleErrors.join("\n    ")}`}`);
    // Rack renders on animation frames (store.ts), so a page that stops
    // getting frames stops updating even though its state is current.
    if (this.window !== undefined && !this.window.isDestroyed()) {
      try {
        const page = await this.js<string>("new Promise((done) => { const timer = setTimeout(() => done('no animation frame within 1s'), 1000); requestAnimationFrame(() => { clearTimeout(timer); done('animation frames firing'); }); }).then((frames) => `${document.visibilityState}, focused: ${document.hasFocus()}, ${frames}`)", DIAGNOSTIC_TIMEOUT_MS);
        lines.push(`  page: ${page}; window visible: ${this.window.isVisible()}, focused: ${this.window.isFocused()}`);
      } catch (error) {
        lines.push(`  page: (unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      }
    }
    for (const { label, read } of this.diagnostics) {
      try {
        const value = await withTimeout(Promise.resolve().then(read), DIAGNOSTIC_TIMEOUT_MS, () => "no answer");
        lines.push(`  ${label}: ${typeof value === "string" ? value : preview(value)}`);
      } catch (error) {
        lines.push(`  ${label}: (unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      }
    }
    const path = this.options.failureScreenshot;
    if (path !== undefined && this.window !== undefined && !this.window.isDestroyed()) {
      try {
        const image = await withTimeout(this.window.webContents.capturePage(), DIAGNOSTIC_TIMEOUT_MS, () => "no answer");
        await writeFile(path, image.toPNG());
        lines.push(`  screenshot: ${path}`);
      } catch (error) {
        lines.push(`  screenshot: (unavailable: ${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return lines.join("\n");
  }

  private async cleanup(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { this.cleanupErrors.push(describe(error)); }
    }
  }
}
