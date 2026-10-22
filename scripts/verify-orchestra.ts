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

// Hold each fixture activity until the actual renderer observes it. These gates
// make consecutive requests/completions deterministic without timing sleeps.
const activityGates = new Map(["shell", "overlap", "remaining", "idle"].map((phase) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return [phase, { ready, release }] as const;
}));

// Open the editor before discovery completes, then change the catalog while it
// remains open. No test-only renderer state hooks are needed for these races.
let releaseCatalog!: () => void;
const catalogReady = new Promise<void>((resolve) => { releaseCatalog = resolve; });
let fixtureModels = ["fixture-planner", "fixture-builder"];

const runtime: RuntimeAdapter = {
  runtimeId: "fixture-runtime", providerId: "fixture",
  models: async () => { await catalogReady; return fixtureModels.map((id) => ({ id, label: id === "fixture-planner" ? "Fixture Planner" : "Fixture Builder", providerId: "fixture" })); },
  capabilities: async () => ({ resume: false, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }),
  describePermissionMode: (mode) => `Fixture ${mode}`,
  cancel: async () => {},
  async *startRun(input: RuntimeRunInput): AsyncIterable<RuntimeEvent> {
    yield { type: "native_session", nativeSessionId: `fixture-${input.runId}` };
    await new Promise((done) => setTimeout(done, 100));
    if (input.prompt.startsWith("Design a Rack workflow")) {
      const answer = await input.requestQuestions!([{ id: "designer-choice", question: "What should the designer create?", options: [{ label: "One agent", description: "A small generated workflow." }], multiSelect: false, allowCustom: true }]);
      if (input.signal.aborted) return;
      assert.deepEqual(answer?.answers["designer-choice"], ["One agent"]);
      const result = JSON.stringify({ id: "generated", name: "Generated fixture", description: "Designed with an answered question", revision: 0, steps: [{ id: "generated-step", name: "Investigate", kind: "agent", agents: [{ id: "generated-agent", name: "Researcher", instructions: "Investigate the task and return findings.", access: "read_only" }] }] });
      yield { type: "completed", result }; return;
    }
    if (input.prompt.includes("ASSIGNMENT:\nImplement")) {
      const decision = await input.requestApproval({ tool: "fixture_write", input: { path: "example.ts" }, reason: "Smoke test only; no file will be changed." });
      assert.equal(decision, "allow");
      const answer = await input.requestQuestions!([{ id: "fixture-choice", question: "Which fixture should be used?", options: [{ label: "Small fixture", description: "No project changes." }], multiSelect: false, allowCustom: true }]);
      assert.deepEqual(answer?.answers["fixture-choice"], ["Small fixture"]);
      yield { type: "tool_request", tool: "fixture_write", toolCallId: "write", input: { path: "example.ts" } };
      await activityGates.get("shell")!.ready;
      yield { type: "tool_request", tool: "fixture_search", toolCallId: "search", input: {} };
      await activityGates.get("overlap")!.ready;
      yield { type: "tool_result", toolCallId: "search", output: "Fixture search completed." };
      await activityGates.get("remaining")!.ready;
      yield { type: "tool_result", toolCallId: "write", output: "Fixture operation completed; no project files changed." };
      await activityGates.get("idle")!.ready;
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
  const js = async <T>(source: string): Promise<T> => {
    try { return await window.webContents.executeJavaScript(source) as T; }
    catch (error) { console.error("Renderer evaluation failed:", source, errors); throw error; }
  };
  async function until(source: string): Promise<void> {
    const end = Date.now() + 10000;
    while (!await js<boolean>(source)) { if (Date.now() > end) { const state = await application.orchestra!.snapshot(); console.error("Fixture state:", { runs: state.runs.map(run => ({ status: run.status, error: run.error, stepIndex: run.stepIndex })), generations: state.generations }, "Renderer errors:", errors); throw new Error(`UI condition timed out: ${source}`); } await new Promise((done) => setTimeout(done, 25)); }
  }
  // Capture after Chromium has painted the asserted view; a successful DOM
  // assertion alone can still produce a screenshot of the previous frame.
  async function capture(path: string): Promise<void> {
    // Pending-input views can contain an intentionally infinite activity pulse.
    // Wait for layout transitions, never for a running indicator to finish.
    await js("Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))");
    await js("new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))");
    await writeFile(path, (await window.webContents.capturePage()).toPNG());
  }
  // checkVisibility excludes content in closed details, which can still have
  // layout rectangles. Otherwise a hidden drafting trigger can intercept a
  // model menu choice with the same label.
  const click = async (name: string) => {
    const target = `(() => { const scope = document.querySelector('.popover') ?? [...document.querySelectorAll('.modal-backdrop')].at(-1) ?? document; return [...scope.querySelectorAll('button')].find(b => b.checkVisibility() && (b.getAttribute('aria-label') === ${JSON.stringify(name)} || b.textContent.trim() === ${JSON.stringify(name)})); })()`;
    await until(`!!${target}`);
    await js(`(() => { const b = ${target}; if (b.disabled) throw new Error('Disabled button: '+b.textContent); b.click(); })()`);
  };
  try {
    console.log("Loading renderer");
    await window.loadFile(resolve("dist-desktop/renderer/index.html"));
    await until("!!document.querySelector('.composer')");
    await js("localStorage.setItem('models.favorites', JSON.stringify(['fixture|fixture-runtime|fixture-planner', 'fixture|fixture-runtime|fixture-builder']))");
    await window.webContents.reload();
    await until("document.querySelector('.session-title')?.textContent === 'Orchestra smoke check'");
    console.log("Opening studio");
    await click("Orchestration"); await click("Create workflow");
    await until("!!document.querySelector('.orchestra-modal')");
    assert.equal(await js<number>("document.querySelectorAll('.orchestra-step').length"), 4);
    console.log("Checking delayed drafting catalog and unavailable selection retention");
    await js("document.querySelector('.orchestra-generate').open = true");
    assert.equal(await js<boolean>("[...document.querySelectorAll('.orchestra-modal button')].find(b=>b.textContent.trim()==='Generate draft').disabled"), true);
    releaseCatalog();
    await until("document.querySelector('[aria-label=\"Workflow drafting model\"]')?.textContent.includes('Fixture Planner') && ![...document.querySelectorAll('.orchestra-modal button')].find(b=>b.textContent.trim()==='Generate draft').disabled");
    fixtureModels = ["fixture-builder"];
    await application.accounts.reauthenticate("fixture-account", { credential: { id: "fixture", method: "test", providerId: "fixture" }, runtimeContextId: "fixture-refresh-1" });
    await application.accounts.updateAvailability("fixture-account", { status: "available" });
    assert.equal((await api.dispatch("accounts.select", { providerId: "fixture", accountId: "fixture-account" })).ok, true);
    await until("document.querySelector('[aria-label=\"Workflow drafting model\"]')?.textContent.includes('fixture-planner · unavailable')");
    assert.equal(await js<boolean>("[...document.querySelectorAll('.orchestra-modal button')].find(b=>b.textContent.trim()==='Generate draft').disabled"), true);
    assert.equal(await js<string>("document.querySelector('input[aria-label=\"Workflow name\"]').value"), "Feature development");
    await click("Workflow drafting model"); await click("Fixture Builder");
    fixtureModels = ["fixture-planner", "fixture-builder"];
    await application.accounts.reauthenticate("fixture-account", { credential: { id: "fixture", method: "test", providerId: "fixture" }, runtimeContextId: "fixture-refresh-2" });
    await application.accounts.updateAvailability("fixture-account", { status: "available" });
    assert.equal((await api.dispatch("accounts.select", { providerId: "fixture", accountId: "fixture-account" })).ok, true);
    await until("document.querySelector('.composer .model-picker-trigger .dropdown-value')?.textContent === 'Fixture Planner'");
    assert.equal(await js<boolean>("document.querySelector('[aria-label=\"Workflow drafting model\"]').textContent.includes('Fixture Builder')"), true);
    await js("document.querySelector('.orchestra-generate').open = false");
    await js("document.querySelector('.orchestra-stage').scrollTop = 300");
    await capture("/tmp/rack-orchestra-editor.png");
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
    assert.deepEqual(await js<string[]>("[...document.querySelectorAll('.orchestra-step-copy strong')].map(node=>node.textContent)"), ["Plan", "Approve the plan", "Build", "Review"]);
    console.log("Saving workflow");
    await click("Save workflow");
    assert.equal((await application.orchestra!.snapshot()).workflows[0]?.steps.find((step) => step.name === "Build")?.agents[0]?.model?.model, "fixture-builder");
    await until("!document.querySelector('.orchestra-modal') && !!document.querySelector('.orchestra-title-row')");
    // Idle sidebar: workflow titles only. Selecting a title applies it.
    assert.equal(await js<boolean>("!document.querySelector('.orchestra-panel-content p, .orchestra-panel-content [role=combobox], .orchestra-library-card')"), true);
    await click("Feature development");
    await until("!!document.querySelector('.orchestra-title-row.applied')");
    await until("document.querySelector('.orchestra-composer-title')?.textContent === 'Feature development'");
    await capture("/tmp/rack-orchestra-titles.png");
    await js("(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value='Implement the fixture feature'; p.dispatchEvent(new Event('input', {bubbles:true})); })()");
    await until("!document.querySelector('button[aria-label=Run]')?.disabled");
    console.log("Starting workflow");
    await click("Run");
    await until("document.querySelector('.orchestra-run-status.waiting_approval') !== null");
    assert.equal((await application.sessions.listSummaries()).length, 1);
    assert.equal((await application.orchestra!.snapshot()).runs[0]?.workers.length, 1);
    // The planner settled before the gate, so it is collapsed automatically.
    assert.equal(await js<boolean>("document.querySelector('.orchestra-agent.completed')?.open"), false);
    assert.equal(await js<string>("document.querySelector('.orchestra-agent .orchestra-agent-model')?.textContent"), "Fixture Planner");
    await capture("/tmp/rack-orchestra-approval.png");
    console.log("Approving plan");
    await click("Approve & continue");
    await until("document.body.textContent.includes('Smoke test only; no file will be changed.')");
    const build = "[...document.querySelectorAll('.orchestra-agent')].find(d=>d.querySelector('.orchestra-agent-name')?.textContent.startsWith('Build'))";
    const buildRows = `[...(${build}?.querySelectorAll('.orchestra-tool-row:not(.working)') ?? [])]`;
    await until("document.querySelector('.orchestra-required-action')?.textContent.includes('Build needs tool approval')");
    assert.equal(await js<string>(`${build}.querySelector('.orchestra-agent-model').textContent`), "Fixture Builder");
    assert.equal(await js<boolean>(`${build}.open && !!${build}.querySelector('summary .orchestra-spinner')`), true);
    await click("Review");
    assert.equal(await js<boolean>("!!document.activeElement?.closest('.approval')"), true);
    await until("!![...document.querySelectorAll('button')].find(b => /Allow/.test(b.textContent))");
    await js("[...document.querySelectorAll('.approval button')].find(b => /Allow/.test(b.textContent)).click()");
    await until("document.querySelector('.orchestra-required-action')?.textContent.includes('Build needs an answer')");
    await click("Answer");
    assert.equal(await js<boolean>("!!document.activeElement?.closest('.question-card')"), true);
    await js("document.querySelector('.question-card input[type=radio]').click()");
    await click("Submit answers");
    await until(`${buildRows}.length === 1 && ${buildRows}[0].dataset.status === 'running' && ${buildRows}[0].querySelector('.orchestra-tool-title').textContent === 'Edit file'`);
    // Keyed rows: remember the first row and the header spinner to prove later
    // updates neither rebuild the row (replaying its entry) nor reset spinners.
    await js(`window.__firstRow = ${buildRows}[0]; window.__statusSpinner = document.querySelector('.orchestra-run-status .orchestra-spinner')`);
    await click("Pause workflow");
    await until("document.querySelector('.orchestra-run-status.paused') !== null");
    await click("Resume workflow");
    await until("document.querySelector('.orchestra-run-status.running') !== null");
    await js("window.__statusSpinner = document.querySelector('.orchestra-run-status .orchestra-spinner')");
    await capture("/tmp/rack-orchestra-working.png");
    activityGates.get("shell")!.release();
    await until(`${buildRows}.length === 2 && ${build}.querySelector('.orchestra-agent-count')?.textContent === '2'`);
    activityGates.get("overlap")!.release();
    await until(`${buildRows}.filter(row => row.dataset.status === 'completed').length === 1`);
    assert.equal(await js<boolean>("window.__firstRow.isConnected && window.__statusSpinner.isConnected"), true);
    activityGates.get("remaining")!.release();
    await until(`${buildRows}.every(row => row.dataset.status === 'completed') && !!${build}.querySelector('.orchestra-tool-row.working .orchestra-shimmer')`);
    await capture("/tmp/rack-orchestra-agent.png");
    activityGates.get("idle")!.release();
    // A finished workflow returns the sidebar to the titles.
    await until("!!document.querySelector('.orchestra-title-row') && !document.querySelector('.orchestra-run')");
    await until("document.querySelector('.orchestra-turn .markdown')?.textContent.includes('workflow completed')");
    const saved = await application.orchestra!.snapshot();
    assert.equal(saved.runs[0]?.status, "completed");
    assert.equal(saved.runs[0]?.workers.length, 4);
    assert.equal(saved.runs[0]?.workers.find(worker => worker.name === "Build")?.model.model, "fixture-builder");
    assert.equal((await application.sessions.listSummaries()).length, 1);
    await window.webContents.reload();
    await until("document.querySelector('.orchestra-turn .markdown')?.textContent.includes('workflow completed')");
    await click("Orchestration");
    await until("!!document.querySelector('.orchestra-title-row')");
    // Exact navigation opens the finished run; tools come from saved journals.
    await click("Add tool tab"); await click("Timeline");
    await until("!!document.querySelector('.orchestra-timeline-run')");
    await js("document.querySelector('.orchestra-timeline-run').click()");
    await until(`!!document.querySelector('.orchestra-run .orchestra-back') && document.querySelector('.orchestra-run-status.completed') !== null && ${buildRows}.length === 2`);
    // Both minimum and typical sidebar widths must contain long activity.
    for (const width of [260, 320]) {
      await js(`document.querySelector('#app').style.setProperty('--workbench-width', '${width}px')`);
      await until(`!!document.querySelector('.orchestra-panel') && Math.round(document.querySelector('.workbench').getBoundingClientRect().width) === ${width}`);
      await js(`(() => { const d = ${build}; if (!d.open) d.querySelector('summary').click(); })()`);
      await until(`${build}.open`);
      assert.equal(await js<boolean>("document.querySelector('.orchestra-panel-content').scrollWidth <= document.querySelector('.orchestra-panel-content').clientWidth"), true);
    }
    await capture("/tmp/rack-orchestra-narrow.png");
    await click("Back to workflows");
    await until("!!document.querySelector('.orchestra-title-row') && !document.querySelector('.orchestra-run')");
    await click("Edit Feature development");
    window.setSize(980, 600);
    await new Promise(done => setTimeout(done, 100));
    assert.equal(await js<boolean>("document.documentElement.scrollWidth <= innerWidth"), true);
    assert.equal(await js<boolean>("document.querySelector('.orchestra-studio-footer').getBoundingClientRect().bottom <= innerHeight"), true);
    await js("document.querySelector('[aria-label=\"Move Review up\"]').focus()");
    await js("document.activeElement.click()");
    assert.equal(await js<string>("document.activeElement?.getAttribute('aria-label')"), "Move Review up");
    await click("Save workflow");
    await until("document.querySelector('.orchestra-studio-footer .error-line')?.textContent.includes('earlier work step')");
    assert.equal(await js<string>("document.activeElement?.getAttribute('aria-label')"), "On review findings");
    await click("Move Review down");
    await js("(() => { const n = document.querySelector('input[aria-label=\"Workflow name\"]'); n.value='Unsaved workflow name'; n.dispatchEvent(new Event('input', {bubbles:true})); })()");
    await click("Cancel");
    await until("[...document.querySelectorAll('.modal-title')].some(node => node.textContent === 'Discard unsaved workflow changes?')");
    await click("Keep editing");
    assert.equal(await js<string>("document.querySelector('input[aria-label=\"Workflow name\"]')?.value"), "Unsaved workflow name");
    await click("Cancel"); await click("Discard changes");
    // Draft routing belongs to each root conversation. Seed the second chat
    // with a real fixture execution to exercise restoration from root history.
    console.log("Checking session-specific composer choices");
    await js("document.querySelector('.composer .model-picker-trigger').click()");
    await click("Fixture Builder"); await click("Done");
    await js("(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value='Unsent original task'; p.dispatchEvent(new Event('input', {bubbles:true})); })()");
    // The navigator currently lists project sessions, so attach the completed
    // standalone fixture to a temporary project for the navigation checks.
    const projectResponse = await api.dispatch("projects.create", { path: directory });
    assert.equal(projectResponse.ok, true);
    const projectId = (projectResponse as { ok: true; value: { id: string } }).value.id;
    assert.equal((await api.dispatch("sessions.attachProject", { sessionId: "fixture-chat", projectId })).ok, true);
    const created = await api.dispatch("sessions.create", { title: "Second fixture chat", projectId });
    assert.equal(created.ok, true);
    const extra = (await application.sessions.listSummaries()).find((session) => session.title === "Second fixture chat")!;
    const seeded = await api.dispatch("runs.start", { sessionId: extra.id, projectId, providerId: "fixture", runtimeId: "fixture-runtime", model: "fixture-planner", permissionMode: "read_only", prompt: "Independent fixture task" });
    assert.equal(seeded.ok, true);
    await until("!!document.querySelector('.tree-folder-toggle')");
    await js("(() => { const folder = document.querySelector('.tree-folder-toggle'); if (folder.getAttribute('aria-expanded') !== 'true') folder.click(); })()");
    await until("[...document.querySelectorAll('.tree-item .nav-title')].some(node => node.textContent === 'Second fixture chat')");
    await js("[...document.querySelectorAll('.tree-item')].find(b=>b.querySelector('.nav-title')?.textContent==='Second fixture chat').click()");
    await until("document.querySelector('.session-title')?.textContent === 'Second fixture chat' && document.querySelector('.composer .model-picker-trigger .dropdown-value')?.textContent === 'Fixture Planner'");
    await js("(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value='Unsent second task'; p.dispatchEvent(new Event('input', {bubbles:true})); })()");
    await js("[...document.querySelectorAll('.tree-item')].find(b=>b.querySelector('.nav-title')?.textContent==='Orchestra smoke check').click()");
    await until("document.querySelector('.composer .model-picker-trigger .dropdown-value')?.textContent === 'Fixture Builder' && document.querySelector('textarea[aria-label=Prompt]')?.value === 'Unsent original task'");
    await js("[...document.querySelectorAll('.tree-item')].find(b=>b.querySelector('.nav-title')?.textContent==='Second fixture chat').click()");
    await until("document.querySelector('.composer .model-picker-trigger .dropdown-value')?.textContent === 'Fixture Planner' && document.querySelector('textarea[aria-label=Prompt]')?.value === 'Unsent second task'");
    console.log("Checking stopping a workflow");
    await js("[...document.querySelectorAll('.tree-item')].find(b=>b.querySelector('.nav-title')?.textContent==='Orchestra smoke check').click()");
    await until("document.querySelector('.session-title')?.textContent === 'Orchestra smoke check'");
    await js("(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.value='Stop this fixture workflow'; p.dispatchEvent(new Event('input', {bubbles:true})); })()");
    await until("!document.querySelector('button[aria-label=Run]')?.disabled");
    await click("Run");
    await until("document.querySelector('.orchestra-run-status.waiting_approval') !== null");
    await click("Stop workflow");
    await until("!!document.querySelector('.orchestra-title-row') && !document.querySelector('.orchestra-run')");
    assert.equal((await application.orchestra!.snapshot()).runs.find((run) => run.prompt === "Stop this fixture workflow")?.status, "stopped");
    console.log("Checking designer questions and cancellation with retained draft");
    await click("Edit Feature development");
    await js("document.querySelector('.orchestra-generate').open = true; document.querySelector('textarea[aria-label=\"Describe a workflow\"]').value='Create a small workflow and ask for clarification'");
    await click("Generate draft");
    await until("!!document.querySelector('.orchestra-modal .question-card')");
    await until("document.querySelector('.orchestra-generation-status')?.textContent === 'Workflow designer needs your answer'");
    // Folding optional settings must never hide the only escape from a
    // waiting designer. The explicit question link restores keyboard context.
    await js("document.querySelector('.orchestra-generate').open = false");
    assert.equal(await js<boolean>("[...document.querySelectorAll('.orchestra-generation-notice button')].find(b=>b.textContent==='Cancel generation').checkVisibility()"), true);
    await click("Answer designer");
    assert.equal(await js<boolean>("!!document.activeElement?.closest('.orchestra-modal .question-card')"), true);
    assert.equal(await js<boolean>("document.querySelector('.orchestra-stage').scrollWidth <= document.querySelector('.orchestra-stage').clientWidth"), true);
    assert.equal(await js<boolean>("document.querySelector('.orchestra-studio-footer').getBoundingClientRect().bottom <= innerHeight"), true);
    await capture("/tmp/rack-orchestra-designer-question.png");
    await js("document.querySelector('.orchestra-modal .question-option input').click()");
    await click("Submit answers");
    await until("document.querySelector('input[aria-label=\"Workflow name\"]')?.value === 'Generated fixture' && !document.querySelector('.orchestra-modal .question-card')");
    assert.equal(await js<string>("document.activeElement?.textContent?.trim()"), "Generate draft");
    assert.equal(await js<string>("document.querySelector('.orchestra-generation-status')?.textContent"), "Draft ready. Review the steps before saving.");
    // A subsequent generated replacement is explicitly confirmed, but neither
    // cancellation path is allowed to discard the pre-existing local draft.
    for (const closeWithEscape of [false, true]) {
      await click("Generate draft"); await click("Discard changes");
      await until("!!document.querySelector('.orchestra-modal .question-card')");
      await js("document.querySelector('.orchestra-generate').open = false");
      if (closeWithEscape) await js("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))");
      else await click("Cancel generation");
      await until("!!document.querySelector('.orchestra-modal') && !document.querySelector('.orchestra-modal .question-card') && [...document.querySelectorAll('.orchestra-modal button')].find(b=>b.textContent.trim()==='Generate draft')?.disabled === false");
      assert.equal(await js<string>("document.querySelector('input[aria-label=\"Workflow name\"]')?.value"), "Generated fixture");
      assert.equal(await js<string>("document.activeElement?.textContent?.trim()"), "Generate draft");
      assert.equal(await js<string>("document.querySelector('.orchestra-generation-status')?.textContent"), "Draft generation cancelled. Your existing draft is retained.");
      assert.deepEqual((await application.orchestra!.snapshot()).generations, []);
      assert.equal(application.orchestra!.isBusy("fixture-chat"), false);
    }
    await click("Generate draft"); await click("Discard changes");
    await until("!!document.querySelector('.orchestra-modal .question-card')");
    const previousOrigin = await js<number>("performance.timeOrigin");
    await window.webContents.reload();
    await until(`performance.timeOrigin !== ${previousOrigin} && !!document.querySelector('.tree-folder-toggle')`);
    await js("(() => { const folder = document.querySelector('.tree-folder-toggle'); if (folder.getAttribute('aria-expanded') !== 'true') folder.click(); })()");
    await until("[...document.querySelectorAll('.tree-item .nav-title')].some(node => node.textContent === 'Orchestra smoke check')");
    await js("[...document.querySelectorAll('.tree-item')].find(b=>b.querySelector('.nav-title')?.textContent==='Orchestra smoke check').click()");
    await until("document.querySelector('.session-title')?.textContent === 'Orchestra smoke check' && !!document.querySelector('.composer .question-card')");
    assert.equal(await js<boolean>("document.querySelector('.designer-recovery')?.textContent.includes(\"Answer the designer's questions\")"), true);
    assert.equal(await js<boolean>("document.querySelector('.composer').scrollWidth <= document.querySelector('.composer').clientWidth"), true);
    await js("document.querySelector('.designer-recovery button').focus()");
    await capture("/tmp/rack-orchestra-designer-recovery.png");
    const recoveryBounds = await js<{ top: number; bottom: number; clipTop: number; clipBottom: number }>("(() => { const b = document.querySelector('.designer-recovery button').getBoundingClientRect(); const overlay = document.querySelector('.composer-overlays').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, clipTop: overlay.top, clipBottom: overlay.bottom }; })()");
    assert.ok(recoveryBounds.top >= recoveryBounds.clipTop - 1 && recoveryBounds.bottom <= recoveryBounds.clipBottom + 1, JSON.stringify(recoveryBounds));
    await click("Cancel generation");
    await until("!document.querySelector('.composer .question-card') && ![...document.querySelectorAll('.composer button')].some(b=>b.textContent.trim()==='Cancel generation')");
    assert.deepEqual((await application.orchestra!.snapshot()).generations, []);
    assert.deepEqual(errors, []);
    console.log("PASS: native authoring/reorder/model assignment, delayed/changed drafting catalogs, designer questions/cancellation/draft retention/reload recovery, save/apply, workflow/tool/question actions, pause/resume/stop, title-only idle sidebar, live agent models and keyed tool waterfall with persistent spinners, automatic agent collapse, final reply, Timeline navigation to saved tool history/reload, 260/320px sidebars, 980x600 editor, validation/draft guards, and session-specific model/prompt retention");
  } finally {
    clearTimeout(watchdog); await api.shutdown(5000); window.destroy(); await rm(directory, { recursive: true, force: true }); await rm(browserDirectory, { recursive: true, force: true, maxRetries: 3 });
  }
}
void verify().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
