/** Native UI/host smoke test for orchestration. All model work uses an explicit
 * fixture runtime in a temporary data directory; no provider account or network
 * model request is used. Build desktop first, then bundle this with esbuild and
 * run the bundle with Electron (see docs/orchestration.md). */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { app, BrowserWindow, ipcMain } from "electron";
import { createApplication } from "../src/composition/application.js";
import { HostApi } from "../src/desktop/host/host-api.js";
import { IPC_CHANNELS } from "../src/contracts/desktop/transport.js";
import type { RuntimeAdapter, RuntimeRunInput, RuntimeEvent } from "../src/core/execution/types.js";

// Isolate Chromium preferences too: running this script must not change
// favorites or tool preferences in the user's normal Rack profile.
const browserDirectory = mkdtempSync(join(tmpdir(), "rack-orchestra-browser-"));
app.setPath("userData", browserDirectory);

// Keep failures visible after the test window is destroyed during cleanup.
app.on("window-all-closed", () => {});

const runtime: RuntimeAdapter = {
  runtimeId: "fixture-runtime", providerId: "fixture",
  models: async () => ["fixture-planner", "fixture-builder"].map((id) => ({ id, label: id === "fixture-planner" ? "Fixture Planner" : "Fixture Builder", providerId: "fixture" })),
  capabilities: async () => ({ resume: false, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }),
  describePermissionMode: (mode) => `Fixture ${mode}`,
  cancel: async () => {},
  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: `fixture-${input.runId}` };
    await new Promise((done) => setTimeout(done, 100));
    if (input.prompt.includes("ASSIGNMENT:\nImplement")) {
      const decision = await input.requestApproval({ tool: "fixture_write", input: { path: "example.ts" }, reason: "Smoke test only; no file will be changed." });
      assert.equal(decision, "allow");
      yield { type: "tool_request", tool: "fixture_write", input: { path: "example.ts" } };
      yield { type: "tool_result", output: "Fixture operation completed; no project files changed." };
    }
    const result = input.prompt.includes("End your response with exactly one final line") ? "The fixture change meets the plan.\nVERDICT: APPROVED"
      : input.prompt.includes("You are Coordinator,") ? "The workflow completed: the plan was approved, the builder finished, and independent review passed. This was a fixture run; no files were changed."
        : input.prompt.includes("ASSIGNMENT:\nImplement") ? "Fixture implementation completed and validated." : "Plan: make the requested change, validate it, and ask an independent reviewer to check the result.";
    yield { type: "message_delta", text: result }; yield { type: "completed", result };
  },
  resumeRun(input) { return this.startRun(input); },
};
async function verify(): Promise<void> {
  console.log("Starting orchestra smoke check…");
  await app.whenReady();
  console.log("Electron ready");
  const watchdog = setTimeout(() => { console.error("Orchestra smoke check timed out."); app.exit(1); }, 45000);
  const directory = await mkdtemp(join(tmpdir(), "rack-orchestra-smoke-"));
  console.log("Preparing temporary application");
  const application = createApplication({ dataDirectory: directory, timeline: false });
  application.runtimes.register(runtime);
  await application.accounts.register({ id: "fixture-account", providerId: "fixture", identity: { providerAccountId: "fixture" }, credential: { id: "fixture", method: "test", providerId: "fixture" }, runtimeContextId: "fixture", availability: "available" });
  await application.sessions.create({ id: "fixture-chat", title: "Orchestra smoke check" });
  const window = new BrowserWindow({ width: 1360, height: 920, show: true, webPreferences: { preload: resolve("dist-desktop/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const api = new HostApi(application, (event) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event); });
  ipcMain.handle(IPC_CHANNELS.invoke, (_event, command, params) => api.dispatch(command, params));
  ipcMain.handle(IPC_CHANNELS.editors, () => []);
  ipcMain.handle(IPC_CHANNELS.presentBrowser, () => undefined);
  const errors: string[] = [];
  window.webContents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
  const js = <T>(source: string) => window.webContents.executeJavaScript(source) as Promise<T>;
  async function until(source: string): Promise<void> {
    const end = Date.now() + 10000;
    while (!await js<boolean>(source)) { if (Date.now() > end) throw new Error(`UI condition timed out: ${source}`); await new Promise((done) => setTimeout(done, 25)); }
  }
  const click = async (name: string) => { await until(`!![...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)})`); await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)}); if (b.disabled) throw new Error('Disabled button: '+b.textContent); b.click(); })()`); };
  try {
    console.log("Loading renderer");
    await window.loadFile(resolve("dist-desktop/renderer/index.html"));
    await until("!!document.querySelector('.composer')");
    await js("localStorage.setItem('models.favorites', JSON.stringify(['fixture|fixture-runtime|fixture-planner', 'fixture|fixture-runtime|fixture-builder']))");
    await window.webContents.reload();
    await until("document.querySelector('.session-title')?.textContent === 'Orchestra smoke check'");
    console.log("Opening studio");
    await click("Orchestration"); await click("Create your first workflow");
    await until("!!document.querySelector('.orchestra-modal')");
    assert.equal(await js<number>("document.querySelectorAll('.orchestra-step').length"), 4);
    await js("document.querySelector('.orchestra-stage').scrollTop = 300");
    await writeFile("/tmp/rack-orchestra-editor.png", (await window.webContents.capturePage()).toPNG());
    // Reordering is a real workflow mutation and has keyboard equivalents.
    await click("Move Build up");
    assert.equal(await js<string>("document.querySelectorAll('.orchestra-step-copy strong')[1].textContent"), "Build");
    await click("Move Build down");
    // Exercise actual pointer movement across the independently scrolling canvas.
    await js(`document.querySelector('[aria-label="Drag Plan to reorder"]').scrollIntoView({block:'nearest'}); document.querySelector('.orchestra-step.approval').scrollIntoView({block:'nearest'});`);
    const dragPoints = await js<{ from: {x:number;y:number}; to: {x:number;y:number} }>(`(() => { const a=document.querySelector('[aria-label="Drag Plan to reorder"]').getBoundingClientRect(); const b=document.querySelector('.orchestra-step.approval .orchestra-step-main').getBoundingClientRect(); return {from:{x:a.x+a.width/2,y:a.y+a.height/2},to:{x:b.x+b.width/2,y:b.y+b.height/2}}; })()`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',...dragPoints.from});
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',buttons:1,clickCount:1,...dragPoints.from});
    for(let n=1;n<=12;n++) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',buttons:1,x:dragPoints.from.x+(dragPoints.to.x-dragPoints.from.x)*n/12,y:dragPoints.from.y+(dragPoints.to.y-dragPoints.from.y)*n/12});
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...dragPoints.to});
    window.webContents.debugger.detach();
    assert.equal(await js<string>("document.querySelectorAll('.orchestra-step-copy strong')[0].textContent"), "Approve the plan");
    await click("Move Plan up");

    await js("[...document.querySelectorAll('.orchestra-step-main')].find(b=>b.querySelector('strong')?.textContent==='Build').click()");
    await click("Agent model"); await click("Fixture Builder");
    console.log("Saving workflow");
    await click("Save workflow");
    await until("!document.querySelector('.orchestra-modal') && !!document.querySelector('.orchestra-library-card')");
    await click("Apply");
    await until("document.querySelector('.orchestra-composer-title')?.textContent === 'Feature development'");
    await js("(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value='Implement the fixture feature'; p.dispatchEvent(new Event('input', {bubbles:true})); })()");
    await until("!document.querySelector('button[aria-label=Run]')?.disabled");
    console.log("Starting workflow");
    await click("Run");
    await until("document.querySelector('.orchestra-status.waiting_approval') !== null");
    assert.equal((await application.sessions.listSummaries()).length, 1);
    assert.equal((await application.orchestra!.snapshot()).runs[0]?.workers.length, 1);
    // Select another model for the future definition; this run retains its snapshot.
    console.log("Approving plan");
    await click("Approve & continue");
    await until("document.body.textContent.includes('Smoke test only; no file will be changed.')");
    await until("!![...document.querySelectorAll('button')].find(b => /Allow/.test(b.textContent))");
    await js("[...document.querySelectorAll('.approval button')].find(b => /Allow/.test(b.textContent)).click()");
    await until("document.querySelector('.orchestra-live .orchestra-status.completed') !== null");
    await until("document.querySelector('.orchestra-turn .markdown')?.textContent.includes('workflow completed')");
    const saved = await application.orchestra!.snapshot();
    assert.equal(saved.runs[0]?.status, "completed");
    assert.equal(saved.runs[0]?.workers.length, 4);
    assert.equal(saved.runs[0]?.workers.find(worker => worker.name === "Build")?.model.model, "fixture-builder");
    await js("[...document.querySelectorAll('.orchestra-worker')].find(b=>b.querySelector('strong')?.textContent==='Build').click()");
    await until("document.querySelector('.orchestra-worker-modal .markdown')?.textContent.includes('Fixture implementation')");
    await click("Close");
    assert.equal((await application.sessions.listSummaries()).length, 1);
    await writeFile("/tmp/rack-orchestra-completed.png", (await window.webContents.capturePage()).toPNG());
    await window.webContents.reload();
    await until("document.querySelector('.orchestra-turn .markdown')?.textContent.includes('workflow completed')");
    await click("Orchestration");
    await until("document.querySelector('.orchestra-live .orchestra-status.completed') !== null");
    await click("Add tool tab"); await click("Timeline");
    await until("!!document.querySelector('.orchestra-timeline-run')");
    await js("document.querySelector('.orchestra-timeline-run').click()");
    await click("Edit Feature development");
    window.setSize(980, 600);
    await new Promise(done => setTimeout(done, 100));
    assert.equal(await js<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
    assert.equal(await js<boolean>("document.querySelector('.orchestra-studio-footer').getBoundingClientRect().bottom <= innerHeight"), true);
    await click("Cancel");
    assert.deepEqual(errors, []);
    console.log("PASS: native editor, pointer/keyboard reorder, model assignment, save/apply, approval gate, worker tool approval/inspection, final reply, hidden contexts, Timeline activity, reload persistence and 980x600 layout");
  } finally {
    clearTimeout(watchdog); await api.shutdown(5000); window.destroy(); await rm(directory, { recursive: true, force: true }); await rm(browserDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}
void verify().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
