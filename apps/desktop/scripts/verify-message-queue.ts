/**
 * Native check for the message queue and editing earlier messages.
 *
 * A fixture runtime holds each turn open until the check releases it (or
 * fails it), so the check decides exactly when turns end. Everything else is
 * real: the host's queue, its end-of-run policy, `runs.edit`, the journal,
 * and the renderer. No provider account, model request or network call is
 * made.
 *
 * It asserts, through the UI:
 * - while a turn runs, Stop and Send are separate; Enter queues instead of
 *   stopping, and the queued stack appears above the composer;
 * - a queued message can be edited inline from the keyboard (Enter saves,
 *   Escape cancels without stopping the run);
 * - the queue is host-owned: it survives a reload;
 * - a completed turn starts the next message by itself;
 * - "Send now" stops the current turn and runs that message next;
 * - a failed turn pauses the queue with the reason, and Resume continues it;
 * - Remove returns focus to the prompt when the stack empties;
 * - Edit on a sent message is unavailable while a turn runs, yet stays
 *   focusable with its reason as the description, and keeps focus when the
 *   turn ends; once idle it opens
 *   an inline editor that states how many turns are replaced and that files
 *   are not reverted; saving hides the replaced turns, labels the new turn
 *   "Edited", and the agent's context holds only the kept history;
 * - after a reload, replaced turns stay hidden.
 * Screenshots are written to /tmp/rack-message-queue-*.png.
 *
 * Timing: the host starts queued messages itself (auto-advance, Send now,
 * Resume, an edit's resend), and the runtime can reach its gate before the
 * window has received `run.started`. Until then the composer still shows
 * "Run". After every host-started turn the check therefore waits for the
 * window to show that turn as running (`waitForRunning`) before it touches
 * the composer. `RACK_CHECK_EVENT_DELAY_MS=150` widens that gap on purpose by
 * delaying everything the host sends the renderer, events and replies alike.
 *
 * Failures print the step, the last wait, the requests the runtime received,
 * the open gates, the queue, the turns and the composer buttons, and save
 * /tmp/rack-message-queue-failure.png (see `fixture-harness.ts`).
 *
 * Build desktop first, then: npm run test:message-queue in apps/desktop.
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
import { FixtureCheck, rendererLink } from "./fixture-harness.js";

const check = new FixtureCheck({ name: "Message queue check", watchdogMs: 90_000, failureScreenshot: "/tmp/rack-message-queue-failure.png" });

// Isolate Chromium preferences from the user's normal Rack profile.
const browserDirectory = mkdtempSync(join(tmpdir(), "rack-message-queue-browser-"));
app.setPath("userData", browserDirectory);
app.on("window-all-closed", () => {});

type Outcome = "complete" | "fail";
/** Turns waiting for the check, by their request text. */
const gates = new Map<string, (outcome: Outcome) => void>();
/** Every prompt the runtime received, in order, including handoff context. */
const received: { readonly request: string; readonly prompt: string }[] = [];

/** The user's request without the conversation context Rack prepends. */
function requestOf(prompt: string): string {
  // Chats also prepend a short workspace note; the request is the last paragraph.
  return prompt.split("Current request:\n").at(-1)!.trim().split("\n\n").at(-1)!.trim();
}

const runtime: RuntimeAdapter = {
  runtimeId: "fixture-runtime", providerId: "fixture",
  models: async () => [{ id: "fixture-model", label: "Fixture Model", providerId: "fixture" }],
  // No native resume: every turn starts fresh with the kept history as context,
  // which lets the check read exactly what the agent was told after an edit.
  capabilities: async () => ({ resume: false, fork: false, approvals: true, quotaReporting: false, browserTools: false, computerUse: false }),
  describePermissionMode: (mode) => `Fixture ${mode}`,
  cancel: async () => {},
  async *startRun(input): AsyncIterable<RuntimeEvent> {
    const request = requestOf(input.prompt);
    received.push({ request, prompt: input.prompt });
    yield { type: "native_session", nativeSessionId: `fixture-${input.runId}` };
    yield { type: "message_delta", text: `Working on: ${request}.` };
    const outcome = await new Promise<Outcome>((done, fail) => {
      const abort = () => { gates.delete(request); fail(new Error("Execution was interrupted.")); };
      if (input.signal.aborted) { abort(); return; }
      input.signal.addEventListener("abort", abort, { once: true });
      gates.set(request, (value) => { input.signal.removeEventListener("abort", abort); gates.delete(request); done(value); });
    });
    if (outcome === "fail") { yield { type: "failed", error: `The fixture failed '${request}'.` }; return; }
    const result = ` Done: ${request}.`;
    yield { type: "message_delta", text: result };
    yield { type: "completed", result: `Working on: ${request}.${result}` };
  },
  resumeRun(input) { return this.startRun(input); },
};

async function verify(): Promise<string> {
  check.onCleanup(() => rm(browserDirectory, { recursive: true, force: true, maxRetries: 3 }));
  const directory = await mkdtemp(join(tmpdir(), "rack-message-queue-"));
  check.onCleanup(() => rm(directory, { recursive: true, force: true }));
  const application = createApplication({ dataDirectory: directory, timeline: false, orchestra: false });
  application.runtimes.register(runtime);
  await application.accounts.register({ id: "fixture-account", providerId: "fixture", identity: { providerAccountId: "fixture" }, credential: { id: "fixture", method: "test", providerId: "fixture" }, runtimeContextId: "fixture", availability: "available" });
  await application.sessions.create({ id: "fixture-chat", title: "Queue check" });
  const window = new BrowserWindow({ width: 1100, height: 900, show: true, backgroundColor: "#121417", webPreferences: { preload: resolve("dist/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  check.attach(window);
  const api = new HostApi(application, rendererLink.events((event) => { if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event); }));
  check.onCleanup(async () => { await api.shutdown(5000); window.destroy(); });
  // Runs first during cleanup, so no turn keeps the host waiting.
  check.onCleanup(() => { for (const gate of gates.values()) gate("complete"); });
  ipcMain.handle(IPC_CHANNELS.invoke, rendererLink.replies((_event: unknown, command: unknown, params: unknown) => api.dispatch(command, params)));
  ipcMain.handle(IPC_CHANNELS.editors, () => []);
  ipcMain.handle(IPC_CHANNELS.presentBrowser, () => undefined);
  const js = <T>(source: string) => check.js<T>(source);
  const until = (source: string, timeoutMs?: number) => check.until(source, timeoutMs);
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const waitForGate = (request: string) => check.untilHost(`the runtime to start '${request}'`, () => gates.has(request));
  function release(request: string, outcome: Outcome = "complete"): void {
    const gate = gates.get(request);
    assert.ok(gate, `'${request}' is not waiting`);
    gate(outcome);
  }
  /** A real key press in the focused element. */
  function press(key: "Enter" | "Escape" | "Space" | "Tab", modifiers: ("shift")[] = []): void {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
    if (key === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
  }
  const type = (text: string) => js(`(() => { const p = document.querySelector('textarea[aria-label=Prompt]'); p.focus(); p.value=${JSON.stringify(text)}; p.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const queueTexts = () => js<string[]>("[...document.querySelectorAll('.message-queue:not([hidden]) .queue-item')].map((row) => row.querySelector('.queue-text, textarea')?.textContent || row.querySelector('textarea')?.value)");
  const turnPrompts = () => js<string[]>("[...document.querySelectorAll('.turn[data-run-id] .bubble-text')].map((node) => node.textContent)");
  const runStatus = (request: string) => js<string | undefined>(`(() => { const turn = [...document.querySelectorAll('.turn[data-run-id]')].find((node) => node.querySelector('.bubble-text')?.textContent === ${JSON.stringify(request)}); return turn ? (turn.querySelector('.run-progress') ? 'running' : 'done') : undefined; })()`);
  const shot = async (name: string) => writeFile(`/tmp/rack-message-queue-${name}.png`, (await window.webContents.capturePage()).toPNG());
  /**
   * A turn the host started: the runtime holds it, and the window shows it as
   * running with Stop available. Only then does the composer queue on Enter.
   */
  async function waitForRunning(request: string): Promise<void> {
    await waitForGate(request);
    await until(`(() => { const turn = [...document.querySelectorAll('.turn[data-run-id]')].find((node) => node.querySelector('.bubble-text')?.textContent === ${JSON.stringify(request)}); return !!turn?.querySelector('.run-progress') && !!document.querySelector('.send-button.is-stop:not([hidden])'); })()`);
  }

  check.diagnose("runtime received", () => received.map((entry) => entry.request));
  check.diagnose("open gates", () => [...gates.keys()]);
  check.diagnose("queued messages", () => queueTexts());
  check.diagnose("turns", () => js<string[]>("[...document.querySelectorAll('.turn[data-run-id]')].map((turn) => `${turn.querySelector('.bubble-text')?.textContent} (${turn.querySelector('.run-progress') ? 'running' : 'done'})`)"));
  check.diagnose("composer buttons", () => js<string[]>("[...document.querySelectorAll('.composer button')].filter((button) => !button.hidden).map((button) => `${button.getAttribute('aria-label') ?? button.textContent?.trim()}${button.disabled ? ' (disabled)' : ''}`)"));
  check.diagnose("prompt", () => js<string>("document.querySelector('textarea[aria-label=Prompt]')?.value ?? '(no prompt)'"));
  check.diagnose("focused element", () => js<string>("(() => { const node = document.activeElement; return node ? `${node.tagName.toLowerCase()}${node.className ? '.' + String(node.className).trim().split(/\\s+/).join('.') : ''}${node.getAttribute('aria-label') ? ` [${node.getAttribute('aria-label')}]` : ''}` : '(none)'; })()"));
  check.diagnose("alerts", () => js<string[]>("[...document.querySelectorAll('[role=alert], .toast, .notice, .notification')].map((node) => node.textContent.trim()).filter(Boolean)"));

  check.step("load");
  await window.loadFile(resolve("dist/renderer/index.html"));
  await until("!!document.querySelector('.composer')");
  await js("(() => { localStorage.setItem('models.favorites', JSON.stringify(['fixture|fixture-runtime|fixture-model'])); localStorage.setItem('appearance', 'dark'); })()");
  await check.reloadAndWait();
  await until("document.querySelector('.session-title')?.textContent === 'Queue check'");

  check.step("1. Stop and Send are separate while a turn runs");
  await type("First task");
  await until("document.querySelector('button[aria-label=Run]')?.disabled === false");
  press("Enter");
  await waitForRunning("First task");
  assert.equal(await js<boolean>("document.querySelector('.send-button:not(.is-stop)').hidden"), true, "with nothing typed, only Stop shows");
  assert.equal(await js<string>("document.querySelector('.send-button.is-stop').getAttribute('aria-label')"), "Stop the running agent (Esc)");

  check.step("2. Enter queues instead of stopping");
  await type("Second task");
  await until("document.querySelector('button[aria-label=\"Queue message\"]')?.hidden === false && !document.querySelector('button[aria-label=\"Queue message\"]').disabled");
  assert.equal(await js<string>("document.querySelector('textarea[aria-label=Prompt]').placeholder"), "Queue a follow-up for after this turn…");
  press("Enter");
  await until("document.querySelectorAll('.message-queue:not([hidden]) .queue-item').length === 1");
  assert.equal(await js<string>("document.querySelector('textarea[aria-label=Prompt]').value"), "", "the prompt clears once queued");
  assert.ok(gates.has("First task"), "Enter did not stop the running turn");
  assert.equal(await runStatus("First task"), "running");

  // The Queue button works too.
  await type("Third task");
  await until("document.querySelector('button[aria-label=\"Queue message\"]')?.disabled === false");
  await js("document.querySelector('button[aria-label=\"Queue message\"]').click()");
  await until("document.querySelectorAll('.message-queue .queue-item').length === 2");
  assert.deepEqual(await queueTexts(), ["Second task", "Third task"]);
  assert.equal(await js<string>("document.querySelector('.queue-heading').textContent"), "2 queued messages");
  // The newest output stays readable: the transcript reserves the stack's height.
  assert.ok(await js<number>("parseFloat(getComputedStyle(document.querySelector('.transcript')).paddingBottom)") > await js<number>("document.querySelector('.message-queue').getBoundingClientRect().height"),
    "the transcript leaves room for the queued stack");
  await wait(350);
  await shot("1-queued");

  check.step("3. Edit a queued message from the keyboard");
  await js("document.querySelectorAll('.queue-item .queue-edit')[1].focus()");
  press("Enter");
  await until("document.activeElement?.matches('.queue-edit-input')");
  press("Escape");
  await until("document.activeElement?.matches('.queue-item .queue-edit') && !document.querySelector('.queue-edit-input')");
  assert.ok(gates.has("First task"), "Escape in the queue editor did not stop the run");
  press("Enter");
  await until("document.activeElement?.matches('.queue-edit-input')");
  await js("(() => { const input = document.activeElement; input.value = 'Third task, edited'; input.dispatchEvent(new Event('input', {bubbles:true})); })()");
  press("Enter");
  await until("!document.querySelector('.queue-edit-input') && [...document.querySelectorAll('.queue-text')].some((node) => node.textContent === 'Third task, edited')");
  assert.deepEqual(await queueTexts(), ["Second task", "Third task, edited"]);

  check.step("4. The queue survives a reload");
  await check.reloadAndWait();
  await until("document.querySelectorAll('.message-queue:not([hidden]) .queue-item').length === 2");
  assert.deepEqual(await queueTexts(), ["Second task", "Third task, edited"]);

  check.step("5. A completed turn starts the next message");
  release("First task");
  await waitForRunning("Second task");
  await until("document.querySelectorAll('.message-queue:not([hidden]) .queue-item').length === 1");
  await until("document.querySelectorAll('.turn[data-run-id]').length === 2");

  check.step("6. Send now stops the current turn");
  await js("document.querySelector('.queue-item .queue-send').click()");
  await waitForRunning("Third task, edited");
  await until("document.querySelector('.message-queue').hidden");
  assert.ok(!gates.has("Second task"), "Send now stopped the running turn");
  await until("[...document.querySelectorAll('.turn[data-run-id]')].some((turn) => turn.querySelector('.bubble-text')?.textContent === 'Second task' && /interrupted|Stopped/.test(turn.textContent))");

  check.step("7. A failed turn pauses the queue; Resume continues it");
  await type("Fourth task");
  await until("document.querySelector('button[aria-label=\"Queue message\"]')?.disabled === false");
  press("Enter");
  await until("document.querySelectorAll('.message-queue:not([hidden]) .queue-item').length === 1");
  release("Third task, edited", "fail");
  await until("!!document.querySelector('.queue-pause:not([hidden])')");
  assert.equal(await js<string>("document.querySelector('.queue-pause span:not(.icon)').textContent"), "Paused because the last turn failed.");
  assert.ok(!gates.has("Fourth task"), "a paused queue does not start the next message");
  await wait(350);
  await shot("2-paused");
  await js("document.querySelector('.queue-resume').focus()");
  press("Enter");
  await waitForRunning("Fourth task");
  await until("document.querySelector('.message-queue').hidden");

  check.step("8. Remove returns focus to the prompt");
  await type("Fifth task");
  await until("document.querySelector('button[aria-label=\"Queue message\"]')?.disabled === false");
  press("Enter");
  await until("document.querySelectorAll('.message-queue:not([hidden]) .queue-item').length === 1");
  await js("document.querySelector('.queue-item .queue-remove').focus()");
  press("Enter");
  await until("document.querySelector('.message-queue').hidden && document.activeElement?.matches('textarea[aria-label=Prompt]')");

  check.step("9. Edit waits for the running turn, and says why to keyboard users");
  // Unavailable Edit is aria-disabled, not disabled: it stays in the tab
  // order and carries its reason as the accessible description.
  assert.equal(await js<boolean>("[...document.querySelectorAll('.turn[data-run-id] .prompt-edit')].every((button) => !button.disabled && button.getAttribute('aria-disabled') === 'true')"), true, "Edit waits for the running turn");
  const blockedEdit = "[...document.querySelectorAll('.turn[data-run-id]')][1].querySelector('.prompt-edit')";
  assert.equal(await js<string | null>(`document.getElementById(${blockedEdit}.getAttribute('aria-describedby'))?.textContent ?? null`), "Stop the current turn before editing an earlier message.", "the reason is the button's description");
  // Reach it the way a keyboard user does: step off it and Tab back.
  await js(`${blockedEdit}.focus()`);
  press("Tab", ["shift"]);
  press("Tab");
  await until(`document.activeElement === ${blockedEdit}`);
  // Keyboard focus shows the reason as a visible hint beside the button.
  // Chromium matches :focus-visible only while the window has OS focus, which
  // a check sharing the desktop cannot guarantee, so focus is emulated for
  // this assertion only (as Puppeteer does).
  await js(`${blockedEdit}.scrollIntoView({ block: 'center' })`);
  window.webContents.debugger.attach("1.3");
  try {
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    assert.equal(await js<boolean>(`${blockedEdit}.matches(':focus-visible') && document.getElementById(${blockedEdit}.getAttribute('aria-describedby')).getBoundingClientRect().width > 40`), true, "the reason is visible while Edit has keyboard focus");
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the reveal transition finish
    await shot("edit-blocked-focus");
  } finally {
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => undefined);
    window.webContents.debugger.detach();
  }
  press("Enter");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(await js<boolean>("document.querySelector('.message-editor') === null"), true, "activating unavailable Edit does nothing");
  release("Fourth task");
  await until("!document.querySelector('.run-progress') && [...document.querySelectorAll('.turn[data-run-id] .prompt-edit')].length === 4 && [...document.querySelectorAll('.prompt-edit')].every((button) => !button.hasAttribute('aria-disabled') && !button.hasAttribute('aria-describedby'))");
  assert.equal(await js<boolean>(`document.activeElement === ${blockedEdit}`), true, "focus stays on Edit when the turn ends and the row is rebuilt");
  assert.deepEqual(await turnPrompts(), ["First task", "Second task", "Third task, edited", "Fourth task"]);

  check.step("10. Edit and resend an earlier message");
  const editSecond = "[...document.querySelectorAll('.turn[data-run-id]')][1].querySelector('.prompt-edit')";
  await js(`${editSecond}.focus()`);
  press("Enter");
  await until("document.activeElement?.matches('.message-editor-input')");
  assert.equal(await js<string>("document.querySelector('.message-editor-warning').textContent"), "Resending replaces this turn and 2 later turns. Files they changed are not reverted.");
  assert.equal(await js<string>("document.activeElement.getAttribute('aria-describedby')"), await js<string>("document.querySelector('.message-editor-warning').id"), "the editor announces the warning");
  await js("document.querySelector('.message-editor').scrollIntoView({ block: 'center' })");
  await wait(350);
  await shot("3-editor");
  press("Escape");
  await until(`!document.querySelector('.message-editor') && document.activeElement === ${editSecond}`);
  press("Enter");
  await until("document.activeElement?.matches('.message-editor-input')");
  await js("(() => { const input = document.activeElement; input.value = 'Second task, rewritten'; input.dispatchEvent(new Event('input', {bubbles:true})); })()");
  const before = received.length;
  press("Enter");
  await waitForRunning("Second task, rewritten");
  await until("!document.querySelector('.message-editor') && document.querySelectorAll('.turn[data-run-id]').length === 2");
  assert.deepEqual(await turnPrompts(), ["First task", "Second task, rewritten"]);
  assert.equal(await js<string>("[...document.querySelectorAll('.turn[data-run-id]')][1].querySelector('.prompt-edited')?.textContent"), "Edited");
  // The agent sees only the kept history plus the edited message.
  const context = received.slice(before).find((entry) => entry.request === "Second task, rewritten")!.prompt;
  assert.ok(context.includes("First task"), "the kept turn is in the agent's context");
  for (const gone of ["Second task.", "Third task, edited", "Fourth task", "Fifth task"]) assert.ok(!context.includes(gone), `replaced or removed message '${gone}' is not in the agent's context`);
  release("Second task, rewritten");
  await until("!document.querySelector('.run-progress')");
  await wait(350);
  await shot("4-edited");

  check.step("11. Replaced turns stay hidden after a reload");
  await check.reloadAndWait();
  await until("document.querySelectorAll('.turn[data-run-id]').length === 2");
  assert.deepEqual(await turnPrompts(), ["First task", "Second task, rewritten"]);
  assert.equal(await js<number>("document.querySelectorAll('.prompt-edited').length"), 1);
  assert.equal(await js<boolean>("document.querySelector('.message-queue').hidden"), true);

  assert.deepEqual(check.consoleErrors, [], "the renderer logged no console errors");
  return "PASS: queue with Enter, inline queue edits, reload, auto-advance, Send now, pause and Resume, Remove; inline message edit replaces later turns and the agent sees only the kept history";
}

check.run(verify);
