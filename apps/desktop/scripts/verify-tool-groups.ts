/**
 * Native check and demo for tool group cards.
 *
 * A fixture runtime plays the "Is anything blocking the 2.8 release?"
 * scenario (`@rack/ui/features/fixtures/release-blocker`) with real delays:
 * search issues (1.2s), read the release project (760ms), query pending
 * migrations (420ms), then ask to post a Slack summary. The approval goes
 * through the real path: the runtime's `requestApproval` callback, the
 * execution service's approval broker and journal, the host, the renderer's
 * inline Allow button and `runs.respondToApproval` back to the runtime. No
 * provider account, model request or network call is made.
 *
 * Verify mode (default) drives the UI and asserts:
 * - the header reads "Using 1 tool" ... "Waiting for approval" ... and
 *   collapses to "Used 4 tools · 3.0s" (within timer tolerance) when the
 *   final answer starts;
 * - each row enters exactly once (no animation replays while text streams),
 *   the card element is never rebuilt, and the motion durations are the
 *   specified ones;
 * - the approval row shows its action and consequence, and Allow works from
 *   the keyboard; the composer only points to it;
 * - rows read as specified, expand with aria-expanded, and show raw details
 *   in monospace; "Run again" is offered under the final answer;
 * - after a reload, the journal replay renders the same collapsed summary,
 *   labels and durations without animating.
 * Screenshots are written to /tmp/rack-tool-groups-*.png.
 *
 * Demo mode (`RACK_DEMO=1`) opens the same setup with the prompt filled in
 * and leaves everything, including Allow/Deny, to you. Send "Check the
 * release again" afterwards to see a failed call and its Retry.
 *
 * Build desktop first, then: npm run test:tool-groups (or demo:tool-groups)
 * in apps/desktop.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { createApplication } from "@rack/host/composition/application";
import { HostApi } from "@rack/host/host-api";
import { IPC_CHANNELS } from "@rack/contracts/transport";
import type { RuntimeAdapter, RuntimeEvent } from "@rack/core/execution/types";
import {
  FINAL_ANSWER,
  MIGRATION_ERROR,
  RELEASE_APPROVAL,
  RELEASE_FAILED_ROW,
  RELEASE_FAILURE_SCENARIO,
  RELEASE_FINAL_ROWS,
  RELEASE_HEADER_DETAIL,
  RELEASE_HEADER_SEQUENCE,
  RELEASE_PROMPT,
  RELEASE_SCENARIO,
  type ScenarioStep,
} from "@rack/ui/features/fixtures/release-blocker";
import { FixtureCheck } from "./fixture-harness.js";

const demo = process.env.RACK_DEMO === "1";
const check = new FixtureCheck({ name: "Tool group check", watchdogMs: demo ? Infinity : 60_000, failureScreenshot: "/tmp/rack-tool-groups-failure.png" });
// Isolate Chromium preferences from the user's normal Rack profile.
const browserDirectory = mkdtempSync(join(tmpdir(), "rack-tool-groups-browser-"));
app.setPath("userData", browserDirectory);
app.on("window-all-closed", () => { if (demo) app.quit(); });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done, fail) => {
    if (signal.aborted) { fail(new Error("Execution was interrupted.")); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); done(); }, ms);
    const abort = () => { clearTimeout(timer); fail(new Error("Execution was interrupted.")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

const runtime: RuntimeAdapter = {
  runtimeId: "fixture-runtime", providerId: "fixture",
  models: async () => [{ id: "fixture-model", label: "Fixture Model", providerId: "fixture" }],
  capabilities: async () => ({ resume: false, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }),
  describePermissionMode: (mode) => `Fixture ${mode}`,
  cancel: async () => {},
  async *startRun(input): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: `fixture-${input.runId}` };
    // The prompt picks the script: the release question, the same question
    // with the database down, or the follow-up a failed row's Retry sends.
    const script: readonly ScenarioStep[] = input.prompt.includes(BROWSER_PROMPT) ? BROWSER_SCENARIO
      : input.prompt.includes(ICONS_PROMPT) ? ICONS_SCENARIO
      : input.prompt.includes(FAILURE_PROMPT) ? RELEASE_FAILURE_SCENARIO
      : input.prompt.includes("Retry the step that failed") ? RETRY_SCENARIO : RELEASE_SCENARIO;
    for (const step of script) {
      await sleep(step.delayMs, input.signal);
      if ("event" in step) { yield step.event; continue; }
      // The real permission path: this resolves only when a client answers.
      const decision = await input.requestApproval(step.approval);
      if (decision === "deny") {
        yield { type: "tool_result", toolCallId: step.approval.toolCallId, output: "The user denied this action.", isError: true };
        const reply = "Understood, I did not post to #release. Two issues (ARC-311, ARC-318) are blocking 2.8, and two migrations are pending.";
        yield { type: "message_delta", text: reply };
        yield { type: "completed", result: reply };
        return;
      }
    }
  },
  resumeRun(input) { return this.startRun(input); },
};

const FAILURE_PROMPT = "Check the release again";
const ICONS_PROMPT = "Ship the branch";
const BROWSER_PROMPT = "Open the changelog";
/** Everyday built-in calls, shaped like Claude's Bash/Read/Edit and Codex's command items. */
const builtin = (id: string, tool: string, input: Record<string, unknown>): ScenarioStep[] => [
  { delayMs: 40, event: { type: "tool_request", tool, toolCallId: id, input } },
  { delayMs: 120, event: { type: "tool_result", toolCallId: id, output: "ok" } },
];
const ICONS_SCENARIO: readonly ScenarioStep[] = [
  { delayMs: 0, event: { type: "message_delta", text: "Checking and shipping the branch." } },
  ...builtin("i-read", "Read", { file_path: "/repo/packages/ui/src/app.ts" }),
  ...builtin("i-edit", "Edit", { file_path: "/repo/docs/tool-groups.md", old_string: "a", new_string: "b" }),
  ...builtin("i-docker", "Read", { file_path: "/repo/infra/Dockerfile" }),
  ...builtin("i-test", "commandExecution", { type: "commandExecution", command: "/bin/zsh -lc 'npm test'" }),
  ...builtin("i-push", "Bash", { command: "cd /repo && git -c credential.helper= push -u origin feat/tool-group-cards 2>&1 | tail -3", description: "Push the feature branch" }),
  ...builtin("i-pr", "Bash", { command: "gh pr view --web" }),
  // Three git commands in a row merge into one row.
  ...builtin("i-git1", "Bash", { command: "git status --short" }),
  ...builtin("i-git2", "Bash", { command: "git diff --stat" }),
  ...builtin("i-git3", "Bash", { command: "cd /repo && git log --oneline -3" }),
  { delayMs: 40, event: { type: "message_delta", text: "Pushed." } },
  { delayMs: 0, event: { type: "completed", result: "Pushed." } },
];
/** The agent reads the page, then opens one: only the second shows the Browser tab. */
const BROWSER_SCENARIO: readonly ScenarioStep[] = [
  { delayMs: 0, event: { type: "message_delta", text: "Opening the changelog." } },
  ...builtin("b-read", "mcp__rack__rack_browser", { action: "snapshot" }),
  ...builtin("b-open", "mcp__rack__rack_browser", { action: "navigate", url: "https://example.com/changelog" }),
  { delayMs: 40, event: { type: "message_delta", text: " Opened." } },
  { delayMs: 0, event: { type: "completed", result: "Opening the changelog. Opened." } },
];
const RETRY_SCENARIO: readonly ScenarioStep[] = [
  { delayMs: 0, event: { type: "message_delta", text: "Retrying the migrations query." } },
  { delayMs: 50, event: { type: "tool_request", tool: "mcp__postgres__query", toolCallId: "call-retry", input: { sql: "select name from pending_migrations" },
    mcp: { server: "postgres", tool: "query", arguments: { sql: "select name from pending_migrations" } } } },
  { delayMs: 300, event: { type: "tool_result", toolCallId: "call-retry", output: [{ type: "text", text: JSON.stringify({ rows: [{ name: "0047" }] }) }] } },
  { delayMs: 50, event: { type: "message_delta", text: "Migration 0047 is still pending on production." } },
  { delayMs: 0, event: { type: "completed", result: "Migration 0047 is still pending on production." } },
];

/** Parses "1.2s" / "760ms" to milliseconds. */
function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(text);
  assert.ok(match, `Unexpected duration text '${text}'`);
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

async function run(): Promise<string> {
  check.onCleanup(() => rm(browserDirectory, { recursive: true, force: true, maxRetries: 3 }));
  const directory = await mkdtemp(join(tmpdir(), "rack-tool-groups-"));
  check.onCleanup(() => rm(directory, { recursive: true, force: true }));
  const application = createApplication({ dataDirectory: directory, timeline: false, orchestra: false });
  application.runtimes.register(runtime);
  await application.accounts.register({ id: "fixture-account", providerId: "fixture", identity: { providerAccountId: "fixture" }, credential: { id: "fixture", method: "test", providerId: "fixture" }, runtimeContextId: "fixture", availability: "available" });
  await application.sessions.create({ id: "fixture-chat", title: "Release check" });
  const window = new BrowserWindow({ width: 1100, height: 900, show: true, backgroundColor: "#121417", webPreferences: { preload: resolve("dist/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  check.attach(window);
  const api = new HostApi(application, (event) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event); });
  check.onCleanup(async () => { await api.shutdown(5000); if (!window.isDestroyed()) window.destroy(); });
  ipcMain.handle(IPC_CHANNELS.invoke, (_event, command, params) => api.dispatch(command, params));
  ipcMain.handle(IPC_CHANNELS.editors, () => []);
  ipcMain.handle(IPC_CHANNELS.presentBrowser, () => undefined);
  const js = <T>(source: string) => check.js<T>(source);
  const until = (source: string, timeoutMs?: number) => check.until(source, timeoutMs);
  const shot = async (name: string) => writeFile(`/tmp/rack-tool-groups-${name}.png`, (await window.webContents.capturePage()).toPNG());

  check.step("load");
  await window.loadFile(resolve("dist/renderer/index.html"));
  await until("!!document.querySelector('.composer')");
  await js("(() => { localStorage.setItem('models.favorites', JSON.stringify(['fixture|fixture-runtime|fixture-model'])); localStorage.setItem('appearance', 'dark'); })()");
  await check.reloadAndWait();
  await until("document.querySelector('.session-title')?.textContent === 'Release check'");
  await js(`(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value=${JSON.stringify(RELEASE_PROMPT)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  if (demo) {
    console.log("Demo ready: press Run, then answer the approval. Close the window to exit.");
    await new Promise<void>((done) => window.on("closed", () => done()));
    return "Demo closed.";
  }

  check.step("live release turn");
  // Record what a viewer sees: header text changes, expansion changes and
  // row-entry animations, with page timestamps.
  await js(`(() => {
    const log = window.__toolGroups = { headers: [], expanded: [], rowAnimations: 0, answerAt: undefined };
    const read = () => {
      const card = document.querySelector('.tool-group-card');
      if (!card) return;
      if (!card.dataset.observed) card.dataset.observed = 'first';
      const text = card.querySelector('.tool-group-status').textContent;
      if (log.headers.at(-1)?.text !== text) log.headers.push({ text, t: performance.now() });
      const expanded = card.querySelector('.tool-group-header').getAttribute('aria-expanded');
      if (log.expanded.at(-1)?.value !== expanded) log.expanded.push({ value: expanded, t: performance.now() });
      if (log.answerAt === undefined && card.nextElementSibling?.classList.contains('md')) log.answerAt = performance.now();
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener('animationstart', (event) => { if (event.animationName === 'tool-row-drop') log.rowAnimations += 1; }, true);
  })()`);
  await until("!document.querySelector('button[aria-label=Run]')?.disabled");
  await js("document.querySelector('button[aria-label=Run]').click()");

  await until("document.querySelectorAll('.tool-row:not(.tool-row-working)').length === 3 && !!document.querySelector('.tool-row[data-status=running]')");
  // Let the new row finish fading in so the capture shows the running state.
  await new Promise((done) => setTimeout(done, 250));
  assert.equal(await js<boolean>("!!document.querySelector('.tool-row[data-status=running] .tool-spinner')"), true, "a running row shows the ring spinner");
  assert.match(await js<string>("getComputedStyle(document.querySelector('.tool-row[data-status=running] .tool-row-label')).animationName"), /tool-shimmer/);
  await shot("1-running");

  check.step("approval row");
  // Approval: highlighted row with action, consequence and real buttons.
  await until("!!document.querySelector('.tool-row.needs-approval .tool-approval button.button-primary:not([disabled])')");
  assert.equal(await js<string>("document.querySelector('.tool-group-status').textContent"), "Waiting for approval");
  assert.equal(await js<string>("document.querySelector('.tool-row.needs-approval .tool-row-label').textContent"), RELEASE_APPROVAL.action);
  assert.equal(await js<string>("document.querySelector('.tool-row.needs-approval .tool-approval-consequence').textContent"), RELEASE_APPROVAL.consequence);
  assert.deepEqual(await js<string[]>("[...document.querySelectorAll('.tool-row.needs-approval .tool-approval button')].map(b => (b.getAttribute('aria-label') ?? b.textContent) + ':' + b.tagName)"),
    ["Show request details:BUTTON", "Deny:BUTTON", "Allow:BUTTON"]);
  assert.equal(await js<boolean>("!!document.querySelector('.approval-pointer') && !document.querySelector('.approval-overlay-card')"), true, "the composer points to the inline approval instead of duplicating it");
  assert.equal(await js<string>("document.querySelector('.tool-group-header').getAttribute('aria-expanded')"), "true");
  await new Promise((done) => setTimeout(done, 300));
  await shot("2-approval");

  // Answer from the keyboard: focus Allow and press Enter.
  await new Promise((done) => setTimeout(done, 600));
  await js("document.querySelector('.tool-row.needs-approval button.button-primary').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
  window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });

  await until("!!document.querySelector('.turn-meta') && document.querySelector('.tool-group-header').getAttribute('aria-expanded') === 'false'");
  await new Promise((done) => setTimeout(done, 400));
  const log = await js<{ headers: { text: string; t: number }[]; expanded: { value: string; t: number }[]; rowAnimations: number; answerAt?: number }>("window.__toolGroups");
  const texts = log.headers.map((entry) => entry.text);
  assert.deepEqual(texts, RELEASE_HEADER_SEQUENCE, `header sequence: ${texts.join(" > ")}`);
  // The time sits on the right of the header, not in the title.
  const detail = await js<string>("document.querySelector('.tool-group-detail').textContent");
  const final = /^(\d+\.\d)s$/.exec(detail);
  assert.ok(final, `header detail: ${detail}`);
  assert.ok(Math.abs(Number(final[1]) - Number.parseFloat(RELEASE_HEADER_DETAIL)) <= 0.15, `group time ${final[1]}s is about ${RELEASE_HEADER_DETAIL}`);
  assert.equal(await js<string>("document.querySelector('.tool-group-caret').getAttribute('class')"), "icon tool-group-caret");
  assert.equal(await js<number>("document.querySelectorAll('.tool-group-icon').length"), 4, "all four brand icons are stacked in the header");
  check.step("collapse as the answer streams");
  // Collapse happens together with the summary, as the answer starts streaming.
  const collapsedAt = log.expanded.find((entry) => entry.value === "false")?.t;
  const summaryAt = log.headers.at(-1)!.t;
  assert.ok(collapsedAt !== undefined && Math.abs(collapsedAt - summaryAt) < 50, "the group collapses when its summary appears");
  assert.ok(log.answerAt !== undefined && Math.abs(log.answerAt - summaryAt) < 50, "the final answer starts directly below the collapsed group");
  assert.equal(log.rowAnimations, 4, "each row animated exactly once");
  assert.equal(await js<string>("document.querySelector('.tool-group-card').dataset.observed"), "first", "the card was patched in place, never rebuilt");
  assert.equal(await js<number>("document.querySelectorAll('.tool-row.entering').length"), 0);
  assert.deepEqual(await js<string[]>("[getComputedStyle(document.querySelector('.tool-group-body')).transitionDuration, getComputedStyle(document.querySelector('.tool-group-body')).transitionProperty]"), ["0.28s", "grid-template-rows"]);
  assert.equal(await js<boolean>("document.querySelector('.tool-group-body').inert"), true, "collapsed rows are not focusable");
  // Reply order: preamble, tool group, final answer, then the turn footer.
  assert.deepEqual(await js<string[]>("[...document.querySelector('.reply').children].map(node => node.className.split(' ')[0])"), ["md", "tool-group-card", "md", "turn-meta"]);
  assert.ok((await js<string>("document.querySelector('.tool-group-card + .md').textContent")).startsWith(FINAL_ANSWER[0]!.trim().slice(0, 20)));
  assert.equal(await js<boolean>("[...document.querySelectorAll('.turn-action')].some(b => b.textContent === 'Run again' && !b.disabled)"), true);
  await shot("3-collapsed");

  const readRows = () => js<{ label: string; summary: string; duration: string; status: string }[]>(`[...document.querySelectorAll('.tool-row:not(.tool-row-working)')].map(row => ({
    label: row.querySelector('.tool-row-label').textContent,
    summary: row.querySelector('.tool-row-summary')?.textContent ?? '',
    duration: row.querySelector('.tool-row-duration')?.textContent ?? '',
    status: row.dataset.status }))`);
  await js("document.querySelector('.tool-group-header').click()");
  await until("document.querySelector('.tool-group-header').getAttribute('aria-expanded') === 'true' && !document.querySelector('.tool-group-body').inert");
  const rows = await readRows();
  assert.deepEqual(rows.map(({ label, summary, status }) => ({ label, summary, status })), RELEASE_FINAL_ROWS.map(({ label, summary }) => ({ label, summary, status: "success" })));
  rows.forEach((row, index) => {
    const expected = parseDuration(RELEASE_FINAL_ROWS[index]!.duration);
    assert.ok(Math.abs(parseDuration(row.duration) - expected) <= 80, `${row.label}: ${row.duration} is about ${RELEASE_FINAL_ROWS[index]!.duration}`);
  });

  check.step("row details");
  // Row details: keyboard toggle, aria-expanded, monospace raw arguments.
  await js("document.querySelector('.tool-row-toggle').focus()");
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
  await until("document.querySelector('.tool-row-toggle').getAttribute('aria-expanded') === 'true' && !document.querySelector('.tool-row-details').hidden");
  assert.match(await js<string>("document.querySelector('.tool-row-details .tool-row-pre').textContent"), /repo:arc-ui\/web/);
  assert.match(await js<string>("getComputedStyle(document.querySelector('.tool-row-pre')).fontFamily"), /Mono/);
  assert.doesNotMatch(await js<string>("getComputedStyle(document.querySelector('.tool-row-label')).fontFamily"), /Mono/);
  // Let the height transition finish, then check the rows are really shown.
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(await js<boolean>("Math.abs(document.querySelector('.tool-group-clip').getBoundingClientRect().height - document.querySelector('.tool-group-rows').scrollHeight) < 2"), true, "the expanded group shows all rows");
  await shot("4-expanded");
  const liveSummary = texts.at(-1)!;
  const liveDetail = detail;

  check.step("replay after a reload");
  // Replay: after a reload the turn is rebuilt from the journal.
  await check.reloadAndWait();
  await until("!!document.querySelector('.tool-group-card .tool-group-status')");
  assert.equal(await js<number>("document.querySelectorAll('.tool-row.entering').length"), 0, "a replayed turn does not animate its rows");
  assert.equal(await js<string>("document.querySelector('.tool-group-status').textContent"), liveSummary, "replay shows the same summary as the live run");
  assert.equal(await js<string>("document.querySelector('.tool-group-detail').textContent"), liveDetail, "replay shows the same time as the live run");
  assert.equal(await js<string>("document.querySelector('.tool-group-header').getAttribute('aria-expanded')"), "false");
  await js("document.querySelector('.tool-group-header').click()");
  await until("!document.querySelector('.tool-group-body').inert");
  assert.deepEqual(await readRows(), rows, "replayed rows match the live rows exactly, durations included");

  check.step("failed call with Retry");
  // A failed call: "Could not ...", its error underneath, "1 failed" in the
  // header, the group left open, and Retry once the turn has finished.
  await js(`(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value=${JSON.stringify(FAILURE_PROMPT)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await until("!document.querySelector('button[aria-label=Run]')?.disabled");
  await js("document.querySelector('button[aria-label=Run]').click()");
  await until("document.querySelectorAll('.turn').length === 2 && !!document.querySelector('.turn:last-child .tool-row-retry')");
  const failedCard = ".turn:last-child .tool-group-card";
  assert.equal(await js<string>(`document.querySelector('${failedCard} .tool-group-status').textContent`), "Used 3 tools");
  assert.equal(await js<string>(`document.querySelector('${failedCard} .tool-group-detail').textContent`), "1 failed");
  assert.equal(await js<boolean>(`document.querySelector('${failedCard} .tool-group-detail').classList.contains('problem')`), true);
  assert.equal(await js<string>(`document.querySelector('${failedCard} .tool-group-header').getAttribute('aria-expanded')`), "true", "a group with a failure stays open");
  assert.deepEqual(await js<string[]>(`(() => { const row = document.querySelector('${failedCard} .tool-row[data-status=error]');
    return [row.querySelector('.tool-row-label').textContent, row.querySelector('.tool-row-subtitle').textContent, row.querySelector('.tool-row-retry').getAttribute('aria-label')]; })()`),
  [RELEASE_FAILED_ROW.label, RELEASE_FAILED_ROW.subtitle, "Retry: Query pending migrations"]);
  // The previous turn no longer offers Run again; only the newest does.
  assert.equal(await js<number>("document.querySelectorAll('.turn-action').length"), 1);
  await new Promise((done) => setTimeout(done, 400));
  await js(`document.querySelector('${failedCard}').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await new Promise((done) => setTimeout(done, 300));
  await shot("5-failed");
  await js(`document.querySelector('${failedCard} .tool-row-retry').click()`);
  await until("document.querySelectorAll('.turn').length === 3 && !!document.querySelector('.turn:last-child .turn-action')");
  assert.equal(await js<string>("document.querySelector('.turn:last-child .bubble-text').textContent"),
    `Retry the step that failed: query pending migrations. It failed with: ${MIGRATION_ERROR}`);
  assert.equal(await js<string>("document.querySelector('.turn:last-child .tool-row-label').textContent"), "Queried pending migrations");

  check.step("everyday tool icons");
  // Everyday calls get their own icons: the program a command runs and the
  // type of file a read or edit touches.
  await js(`(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value=${JSON.stringify(ICONS_PROMPT)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await until("!document.querySelector('button[aria-label=Run]')?.disabled");
  await js("document.querySelector('button[aria-label=Run]').click()");
  await until("document.querySelectorAll('.turn').length === 4 && !!document.querySelector('.turn:last-child .turn-action')");
  await js("(() => { const header = document.querySelector('.turn:last-child .tool-group-header'); if (header.getAttribute('aria-expanded') !== 'true') header.click(); })()");
  await until("!document.querySelector('.turn:last-child .tool-group-body').inert");
  const topRows = "[...document.querySelectorAll('.turn:last-child .tool-group-card .tool-group-rows > .tool-row:not(.tool-row-working)')]";
  assert.deepEqual(await js<string[][]>(`${topRows}.map(row => [row.querySelector('.tool-row-icon').dataset.icon, row.querySelector('.tool-row-label').textContent])`), [
    ["brand-typescript", "Read app.ts"], ["brand-markdown", "Edited tool-groups.md"], ["brand-docker", "Read Dockerfile"],
    ["brand-npm", "Ran npm test"], ["brand-git", "Push the feature branch"], ["brand-github", "Ran gh pr view --web"],
    ["brand-git", "Ran 3 git commands"],
  ]);
  // The merged row expands to its own calls.
  await js(`${topRows}.at(-1).querySelector('.tool-row-toggle').click()`);
  assert.deepEqual(await js<string[]>(`[...${topRows}.at(-1).querySelectorAll('.tool-cluster-rows > .tool-row .tool-row-label')].map(label => label.textContent)`),
    ["Ran git status --short", "Ran git diff --stat", "Ran git log --oneline -3"]);
  await new Promise((done) => setTimeout(done, 400));
  await js("document.querySelector('.turn:last-child .tool-group-card').scrollIntoView({ block: 'center', behavior: 'instant' })");
  await new Promise((done) => setTimeout(done, 200));
  await shot("6-icons");

  check.step("agent browser reveals its tab");
  // The agent's page is a native view shown only through the Browser tab.
  // Reading the page leaves the panel alone; opening one brings it forward.
  const activeTool = "document.querySelector('.workbench-tab-item.active [data-tool]')?.dataset.tool";
  assert.notEqual(await js<string | undefined>(activeTool), "browser");
  await js(`(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value=${JSON.stringify(BROWSER_PROMPT)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await until("!document.querySelector('button[aria-label=Run]')?.disabled");
  const revealedBefore = await js<boolean>(`${activeTool} === 'browser'`);
  await js("document.querySelector('button[aria-label=Run]').click()");
  await until("document.querySelectorAll('.turn').length === 5 && !!document.querySelector('.turn:last-child .turn-action')");
  assert.equal(revealedBefore, false);
  await until(`${activeTool} === 'browser' && !!document.querySelector('.browser-panel')?.isConnected`);
  await shot("7-browser-revealed");
  assert.deepEqual(check.consoleErrors, []);
  return `PASS: ${texts.join(" > ")} [${liveDetail}]; rows ${rows.map((row) => `${row.label} (${row.summary} · ${row.duration})`).join(", ")}; replay identical; failed row with Retry; agent page change reveals the Browser tab`;
}

check.run(run);
