import { createApplication } from "@rack/host/composition/application";
import { HostApi } from "@rack/host/host-api";
/** Native smoke check for the shared Chromium view and fallback PTY.
 * Run with npm run test:desktop-features. It uses only temporary project
 * files and a loopback website; no provider login or model turn is started.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { SharedBrowser } from "../src/main/shared-browser.js";
import { LocalPtyBackend } from "@rack/node-adapters/pty/local-pty";
import { TerminalService } from "@rack/features/terminal";
import { CodexRuntimeAdapter } from "@rack/runtimes/codex/codex";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the native feature.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Electron waits for its ESM entry module before emitting ready. Do not hold
// module evaluation open with a top-level await of app.whenReady().
async function verify(): Promise<void> {
  await app.whenReady();
  const watchdog = setTimeout(() => { console.error("Native feature check timed out."); app.exit(1); }, 45_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), "rack-native-features-")));
  const browser = new SharedBrowser();
  const terminals = new TerminalService(new LocalPtyBackend());
  const owner = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>Rack browser check</title>
      <form id="form"><label>Name<input aria-label="Name"></label>
      <select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
      <button>Submit</button></form><p id="result">Waiting</p><p id="bridge"></p><p id="cookie"></p><p id="key"></p>
      <script>document.getElementById('bridge').textContent = typeof process + ':' + typeof window.harness;
      document.getElementById('cookie').textContent = 'Previous cookie: ' + (document.cookie || 'empty'); document.cookie = 'rackSmoke=first';
      document.addEventListener('keydown', event => { document.getElementById('key').textContent = 'Key: ' + event.key + ' target: ' + event.target.tagName; });
      document.getElementById('form').onsubmit = event => { event.preventDefault(); document.getElementById('result').textContent = 'Submitted ' + document.querySelector('input').value + ' ' + document.querySelector('select').value; };</script>`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    // State polling alone cannot allocate tabs or exhaust their capacity.
    for (let index = 0; index < 15; index++) assert.equal((await browser.control(`empty:${index}`, { action: "state" })).url, "");
    for (let index = 0; index < 15; index++) await assert.rejects(browser.control(`invalid:${index}`, { action: "navigate", url: "file:///etc/passwd" }), /http or https/);
    console.log("Checking browser navigation…");
    await browser.control("first", { action: "navigate", url });
    await until(async () => { const state = await browser.control("first", { action: "state" }); return !state.loading && state.title === "Rack browser check"; });
    console.log("Checking browser snapshot…");
    let state = await browser.control("first", { action: "snapshot", actor: "agent" });
    assert.match(state.page!, /undefined:undefined/);
    const ref = (page: string, name: string): string => {
      const line = page.split("\n").find((line) => line.includes(name) && line.startsWith("["));
      assert.ok(line, `Missing control: ${name}`);
      return line.slice(1, line.indexOf("]"));
    };
    const stale = ref(state.page!, "input Name");
    console.log("Checking browser form controls…");
    state = await browser.control("first", { action: "type", actor: "agent", ref: stale, text: "Ada" });
    await assert.rejects(browser.control("first", { action: "click", actor: "agent", ref: stale }), /Stale/);
    state = await browser.control("first", { action: "select", actor: "agent", ref: ref(state.page!, "select Color"), text: "blue" });
    await browser.control("first", { action: "click", actor: "agent", ref: ref(state.page!, "button Submit") });
    assert.match((await browser.control("first", { action: "snapshot", actor: "agent" })).page!, /Submitted Ada blue/);
    state = await browser.control("first", { action: "snapshot", actor: "agent" });
    await browser.control("first", { action: "type", actor: "agent", ref: ref(state.page!, "input Name"), text: "Grace" });
    await browser.control("first", { action: "press", actor: "agent", text: "Enter" });
    await until(async () => /Submitted Grace blue/.test((await browser.control("first", { action: "snapshot", actor: "agent" })).page!));
    await browser.control("second", { action: "navigate", url });
    await until(async () => !(await browser.control("second", { action: "state" })).loading);
    assert.match((await browser.control("second", { action: "snapshot", actor: "agent" })).page!, /Previous cookie: empty/);
    browser.present(owner, { sessionId: "first", visible: true, bounds: { x: 10, y: 20, width: 500, height: 400 } });
    assert.equal(owner.contentView.children.length, 1);
    browser.present(owner, { visible: false });
    assert.equal(owner.contentView.children.length, 0);
    await browser.control("first", { action: "agent", enabled: false });
    await assert.rejects(browser.control("first", { action: "snapshot", actor: "agent" }), /paused/);
    await assert.rejects(browser.control("first", { action: "agent", actor: "agent", enabled: true }), /Only the user/);
    await browser.control("first", { action: "agent", enabled: true });
    await browser.control("first", { action: "close" });
    assert.equal((await browser.control("first", { action: "state" })).url, "");
    console.log("PASS: shared Chromium page, form controls, stale refs, isolated bridge, attachment, pause/resume and close");

    // /bin/sh avoids user shell plugins/history during this disposable check.
    process.env["SHELL"] = "/bin/sh";
    const shell = await terminals.open("test", directory, 80, 24);
    await terminals.write(shell.id, "printf '\\nRACK_PTY:%s\\n' \"$PWD\"\n");
    await until(() => terminals.read(shell.id).output.includes(`RACK_PTY:${directory}`));
    await terminals.resize(shell.id, 101, 33);
    await terminals.write(shell.id, "stty size\n");
    await until(() => /33\s+101/.test(terminals.read(shell.id).output));
    assert.equal((await terminals.open("test", directory, 80, 24)).id, shell.id);
    await terminals.write(shell.id, "exit 7\n");
    await until(() => terminals.read(shell.id).exited);
    assert.equal(terminals.read(shell.id).exitCode, 7);
    console.log("PASS: real PTY input/output, project cwd, resize, reconnect and exit status");

    // Codex's command API works without a login or a thread. A fresh context
    // prevents this check from reading the user's provider sessions/config.
    const context = join(directory, "codex"); await mkdir(context);
    const codex = new CodexRuntimeAdapter({ resolve: async () => ({ environment: {} }) }, { resolve: async () => ({ directory: context }) });
    const native = await terminals.open("codex", directory, 80, 24, { label: "Codex terminal", start: (input) => codex.openTerminal({ ...input,
      account: { accountId: "test", providerId: "codex", credential: { id: "test", providerId: "codex", method: "native_login" }, runtimeContextId: "test" },
    }) });
    assert.equal(native.backend, "Codex terminal");
    await terminals.write(native.id, "printf '\\nRACK_CODEX_PTY:%s\\n' \"$PWD\"\n");
    await until(() => terminals.read(native.id).output.includes(`RACK_CODEX_PTY:${directory}`));
    await terminals.close(native.id);
    console.log("PASS: real Codex standalone terminal without provider login or model turn");

    // Exercise the public host boundary with no Project record at all. This
    // catches accidental project-only resolution in Files, Terminal or Browser.
    const application = createApplication({ dataDirectory: join(directory, "application"), timeline: false, browser });
    const host = new HostApi(application, () => {});
    const call = async (command: string, params: unknown = {}) => {
      const response = await host.dispatch(command, params);
      assert.ok(response.ok, response.ok ? "" : response.error.message);
      return response.value as any;
    };
    try {
      const chat = await call("sessions.create");
      assert.equal(chat.projectId, undefined);
      assert.equal((await call("projects.list")).length, 0);
      const cwd = await call("sessions.directory", { sessionId: chat.id });
      assert.ok(cwd.includes("chat-files")); assert.ok(!cwd.includes("runtime-contexts"));
      await writeFile(join(cwd, "report.md"), "# Generated report");
      assert.equal((await call("sessions.files.list", { sessionId: chat.id, path: "" })).entries[0].name, "report.md");
      const document = await call("sessions.files.read", { sessionId: chat.id, path: "report.md" });
      await call("sessions.files.save", { sessionId: chat.id, path: "report.md", text: "# Reviewed report", version: document.version });
      const escaped = await host.dispatch("sessions.files.read", { sessionId: chat.id, path: "../accounts.json" });
      assert.equal(escaped.ok, false);
      const terminal = await call("terminal.open", { sessionId: chat.id, cols: 80, rows: 24 });
      await call("terminal.write", { terminalId: terminal.id, data: "printf '\\nRACK_CHAT_PTY:%s\\n' \"$PWD\"\n" });
      await until(async () => (await call("terminal.read", { terminalId: terminal.id, after: 0 })).output.includes(`RACK_CHAT_PTY:${cwd}`));
      await call("browser.control", { sessionId: chat.id, request: { action: "navigate", url } });
      await until(async () => !(await call("browser.control", { sessionId: chat.id, request: { action: "state" } })).loading);
      const reopened = createApplication({ dataDirectory: application.dataDirectory, timeline: false });
      assert.equal((await reopened.sessions.get(chat.id)).originatedAsChat, true);
      assert.equal(await reopened.sessions.workspace(chat.id), cwd);
      await call("sessions.remove", { sessionId: chat.id });
      assert.equal((await call("sessions.list")).length, 0);
      assert.equal((await host.dispatch("terminal.read", { terminalId: terminal.id, after: 0 })).ok, false);
      console.log("PASS: project-free chat persistence, safe Files read/save, private PTY cwd, Browser and deletion cleanup");
    } finally { await host.shutdown(); }

  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await terminals.shutdown();
    browser.shutdown();
    owner.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    clearTimeout(watchdog);
    app.exit(process.exitCode ?? 0);
  }
}
void verify().catch((error: unknown) => { console.error(error); app.exit(1); });
