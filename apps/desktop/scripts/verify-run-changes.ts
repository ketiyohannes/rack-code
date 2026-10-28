/** Native UI check for the per-response "files changed" summary, thinking
 * presentation and routine availability notices. A fixture runtime reports a
 * Claude-style Edit and a Codex-style fileChange in a temporary data
 * directory; no provider account, model request or real file edit is made.
 * Build desktop first, then bundle this with esbuild and run it with Electron
 * (see docs/desktop.md). */
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
import { FixtureCheck } from "./fixture-harness.js";

const check = new FixtureCheck({ name: "Run changes check", watchdogMs: 30_000, untilMs: 10_000, failureScreenshot: "/tmp/rack-run-changes-failure.png" });

// Isolate Chromium preferences from the user's normal Rack profile.
const browserDirectory = mkdtempSync(join(tmpdir(), "rack-run-changes-browser-"));
app.setPath("userData", browserDirectory);
app.on("window-all-closed", () => {});

const runtime: RuntimeAdapter = {
  runtimeId: "fixture-runtime", providerId: "fixture",
  models: async () => [{ id: "fixture-model", label: "Fixture Model", providerId: "fixture" }],
  capabilities: async () => ({ resume: false, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }),
  describePermissionMode: (mode) => `Fixture ${mode}`,
  cancel: async () => {},
  async *startRun(input): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: `fixture-${input.runId}` };
    yield { type: "thinking_delta", text: "Checking the greeting helper.", format: "summary" };
    yield { type: "tool_request", tool: "Edit", toolCallId: "edit", input: { file_path: "src/greet.ts", old_string: "return \"hi\";", new_string: "return `Hello, ${name}!`;" } };
    yield { type: "tool_result", toolCallId: "edit", output: { content: "Edited." } };
    const changes = [{ path: "src/greet.test.ts", kind: { type: "add" }, diff: "import { greet } from \"./greet.js\";\nassert.equal(greet(\"Ada\"), \"Hello, Ada!\");\n" }];
    yield { type: "tool_request", tool: "fileChange", toolCallId: "patch", input: { type: "fileChange", id: "patch", changes } };
    yield { type: "tool_result", toolCallId: "patch", output: { type: "fileChange", id: "patch", status: "completed", changes } };
    const result = "Updated the greeting and added a test.";
    yield { type: "message_delta", text: result };
    yield { type: "availability", status: "available" };
    yield { type: "completed", result };
  },
  resumeRun(input) { return this.startRun(input); },
};

async function verify(): Promise<string> {
  check.onCleanup(() => rm(browserDirectory, { recursive: true, force: true, maxRetries: 3 }));
  const directory = await mkdtemp(join(tmpdir(), "rack-run-changes-"));
  check.onCleanup(() => rm(directory, { recursive: true, force: true }));
  const application = createApplication({ dataDirectory: directory, timeline: false, orchestra: false });
  application.runtimes.register(runtime);
  await application.accounts.register({ id: "fixture-account", providerId: "fixture", identity: { providerAccountId: "fixture" }, credential: { id: "fixture", method: "test", providerId: "fixture" }, runtimeContextId: "fixture", availability: "available" });
  await application.sessions.create({ id: "fixture-chat", title: "Run changes check" });
  const window = new BrowserWindow({ width: 1200, height: 860, show: true, webPreferences: { preload: resolve("dist/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  check.attach(window);
  const api = new HostApi(application, (event) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event); });
  check.onCleanup(async () => { await api.shutdown(5000); window.destroy(); });
  ipcMain.handle(IPC_CHANNELS.invoke, (_event, command, params) => api.dispatch(command, params));
  ipcMain.handle(IPC_CHANNELS.editors, () => []);
  ipcMain.handle(IPC_CHANNELS.presentBrowser, () => undefined);
  const js = <T>(source: string) => check.js<T>(source);
  const until = (source: string) => check.until(source);
  check.step("load");
  await window.loadFile(resolve("dist/renderer/index.html"));
  await until("!!document.querySelector('.composer')");
  await js("localStorage.setItem('models.favorites', JSON.stringify(['fixture|fixture-runtime|fixture-model']))");
  await check.reloadAndWait();
  await until("document.querySelector('.session-title')?.textContent === 'Run changes check'");
  check.step("run a turn that changes files");
  await js("(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value='Greet by name and add a test'; p.dispatchEvent(new Event('input', {bubbles:true})); })()");
  await until("!document.querySelector('button[aria-label=Run]')?.disabled");
  await js("document.querySelector('button[aria-label=Run]').click()");
  await until("!!document.querySelector('.run-changes') && !!document.querySelector('.turn-meta')");

  check.step("collapsed change summary");
  assert.equal(await js<string>("document.querySelector('.run-changes-title').textContent"), "2 files changed");
  assert.equal(await js<string>("document.querySelector('.run-changes > summary .run-changes-stats').textContent"), "+3−1");
  assert.equal(await js<boolean>("document.querySelector('.run-changes').open"), false, "the summary starts collapsed");
  assert.equal(await js<boolean>("document.querySelector('.reply').lastElementChild.previousElementSibling.classList.contains('run-changes')"), true, "the summary closes the reply, before its metadata");
  assert.equal(await js<number>("document.querySelectorAll('.thinking-toggle').length"), 0);
  assert.equal(await js<string>("document.querySelector('.thinking-panel')?.getAttribute('aria-label')"), "Reasoning summary");
  assert.equal(await js<boolean>("document.querySelector('.transcript').textContent.includes('account available')"), false);

  check.step("expanded diff and styling parity");
  await js("document.querySelector('.run-changes > summary').click()");
  // Files use the Changes tab's rows: name, folder and status letter.
  assert.deepEqual(await js<string[]>("[...document.querySelectorAll('.run-changes .git-file-row')].map(row => row.querySelector('.git-file-name').textContent + ' ' + row.querySelector('.git-file-status').textContent)"), ["greet.ts M", "greet.test.ts A"]);
  await js("document.querySelector('.run-changes .git-file-row').click()");
  await until("document.querySelectorAll('.run-changes .git-file-diff .git-diff-line.added').length === 1 && document.querySelector('.run-changes .git-diff-source')?.textContent === 'This reply'");
  // Parity: render the same rows inside the Changes tab's container and
  // compare computed colors and font sizes with the reply card.
  const parity = await js<{ reply: string[]; changes: string[] }>(`(() => {
    const sample = (root) => {
      const added = root.querySelector('.git-diff-line.added'), removed = root.querySelector('.git-diff-line.removed'), sign = added.querySelector('.git-line-sign');
      const name = root.querySelector('.git-file-name'), status = root.querySelector('.git-file-status'), scroll = root.querySelector('.git-diff-scroll');
      return [getComputedStyle(added).backgroundColor, getComputedStyle(added).boxShadow, getComputedStyle(removed).backgroundColor, getComputedStyle(sign).color,
        getComputedStyle(scroll).fontSize, getComputedStyle(scroll).fontFamily, getComputedStyle(scroll).lineHeight, getComputedStyle(name).fontSize, getComputedStyle(status).color];
    };
    const card = document.querySelector('.run-changes .run-changes-body');
    const reference = document.createElement('div');
    reference.className = 'git-changes-content';
    reference.append(card.cloneNode(true));
    document.querySelector('.workbench, body').append(reference);
    const result = { reply: sample(card), changes: sample(reference) };
    reference.remove();
    return result;
  })()`);
  assert.deepEqual(parity.reply, parity.changes, "the reply diff matches the Changes tab styling");
  assert.notEqual(parity.reply[0], "rgba(0, 0, 0, 0)", "added lines are highlighted");
  await js("document.querySelector('.run-changes button[aria-label=\"Toggle split diff\"]').click()");
  await until("!!document.querySelector('.run-changes .git-diff-scroll.split')");
  await js("document.querySelector('.run-changes button[aria-label=\"Toggle split diff\"]').click()");
  await until("!!document.querySelector('.run-changes .git-diff-scroll[data-diff-layout=inline]')");
  // Later store updates redraw the turn; selection must survive them.
  await new Promise((done) => setTimeout(done, 800));
  assert.equal(await js<boolean>("document.querySelector('.run-changes').open && !!document.querySelector('.run-changes .git-file-row.selected')"), true, "selection survives redraws");
  await writeFile("/tmp/rack-run-changes.png", (await window.webContents.capturePage()).toPNG());
  // After a reload the summary is rebuilt from the persisted run journal.
  check.step("summary rebuilt after a reload");
  await check.reloadAndWait();
  await until("!!document.querySelector('.run-changes')");
  assert.deepEqual(check.consoleErrors, []);
  return "PASS: collapsed per-response file changes with diffs, no thinking icon, no routine availability notice";
}

check.run(verify);
