/** Terminal is kept attached to its own context container. Re-rendering chat or
 * switching surfaces never restarts the shell or replaces terminal output.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { icon } from "../icons.js";
import type { Controller } from "../controller.js";
import type { Store } from "../store.js";
import { h, replace } from "../dom.js";
import type { TerminalSnapshot } from "../../../features/terminal/types.js";

interface Client { terminal: Terminal; fit: FitAddon; element: HTMLElement; id: string; offset: number; exited: boolean; backend: string; writes: Promise<unknown>; opened: boolean; pendingOutput: string; appearance?: string; exitCode?: number }
export function createTerminalPanel(store: Store, controller: Controller, isVisible: () => boolean) {
  let active = false; let generation = 0; let loading = false; let reading = false;
  let selectedProjectId: string | undefined;
  let selected: string | undefined; let current: Client | undefined;
  const clients = new Map<string, Client>();
  const status = h("span", { class: "terminal-status" });
  const error = h("p", { class: "panel-error", role: "alert" });
  const viewport = h("div", { class: "terminal-viewport" });
  viewport.addEventListener("keydown", (event) => event.stopPropagation());
  const restart = h("button", { class: "icon-button", type: "button", title: "Restart shell", aria: { label: "Restart shell" }, onClick: () => void open(true) }, icon("arrow-clockwise"));
  const close = h("button", { class: "icon-button", type: "button", title: "Close shell", aria: { label: "Close shell" }, onClick: () => void closeCurrent() }, icon("x"));
  const element = h("div", { class: "terminal-panel" }, h("div", { class: "terminal-toolbar" }, status, restart, close), error, viewport);

  function renderStatus(): void { status.textContent = loading ? "Opening shell…" : current === undefined ? "Shell" : `${current.backend === "local" ? "Shell" : current.backend}${current.exited ? ` · Exited${current.exitCode === undefined ? "" : ` (${current.exitCode})`}` : ""}`; restart.disabled = loading || (store.get().selection.projectId === undefined && store.get().selection.sessionId === undefined); close.disabled = loading || current === undefined; }
  function appearance(client: Client): void {
    const style = getComputedStyle(viewport);
    const hex = (color: string) => {
      const components = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      return components ? `#${components.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}` : color;
    };
    const key = JSON.stringify([style.fontSize, style.fontFamily, style.backgroundColor, style.color, style.borderTopColor]);
    if (client.appearance === key) return;
    client.appearance = key;
    client.terminal.options.fontSize = parseFloat(style.fontSize) || 15;
    client.terminal.options.fontFamily = style.fontFamily;
    client.terminal.options.theme = { background: hex(style.backgroundColor), foreground: hex(style.color), cursor: hex(style.color), selectionBackground: hex(style.borderTopColor) };
  }
  function fit(): void {
    if (!active || !isVisible() || current === undefined || viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
    const client = current;
    client.fit.fit();
    void controller.resizeTerminal(client.id, Math.max(2, client.terminal.cols), Math.max(1, client.terminal.rows)).catch(() => {});
  }
  function attach(client: Client): void {
    current = client;
    if (!viewport.contains(client.element)) replace(viewport, client.element);
    // Terminal measures fonts and initializes its renderer during open(). A
    // detached container has zero dimensions and can leave a blank terminal
    // even after it is inserted. Open only after attachment; inactive clients
    // can buffer output until their context becomes visible.
    if (!client.opened) { appearance(client); client.terminal.open(client.element); client.opened = true;
      if (client.pendingOutput) { client.terminal.write(client.pendingOutput); client.pendingOutput = ""; }
    } else appearance(client);
    fit();
    requestAnimationFrame(() => {
      if (current !== client || !active) return;
      fit(); client.terminal.resize(client.terminal.cols, client.terminal.rows);
    });
    renderStatus();
  }
  async function open(fresh = false): Promise<void> {
    const state = store.get(); const projectId = state.selection.projectId;
    if (!active || !isVisible() || (projectId === undefined && state.selection.sessionId === undefined) || loading || selected === undefined || state.host.status !== "ready") return;
    const context = selected; const version = generation;
    if (!fresh && clients.has(context)) { attach(clients.get(context)!); return; }
    loading = true; renderStatus(); error.textContent = "";
    try {
      const old = clients.get(context);
      if (old !== undefined) {
        await controller.closeTerminal(old.id); old.terminal.dispose(); clients.delete(context);
        if (current === old) { current = undefined; viewport.replaceChildren(); }
      }
      if (version !== generation || !active || !isVisible() || !viewport.isConnected) return;
      const font = getComputedStyle(viewport);
      await document.fonts.load(`${font.fontSize} ${font.fontFamily}`);
      await document.fonts.ready;
      if (version !== generation || !active || !isVisible() || !viewport.isConnected) return;
      const snapshot = await controller.openTerminal(projectId, state.selection.sessionId, 80, 24);
      const terminal = new Terminal({ cols: 80, rows: 24, fontSize: 15, cursorBlink: true, scrollback: 5000, convertEol: false });
      const addon = new FitAddon(); terminal.loadAddon(addon);
      const container = h("div", { class: "terminal-instance" });
      const client: Client = { terminal, fit: addon, element: container, id: snapshot.id, offset: 0, exited: snapshot.exited, backend: snapshot.backend, writes: Promise.resolve(), opened: false, pendingOutput: "" };
      clients.set(context, client);
      terminal.onData((data) => {
        // Preserve paste/key order while bounding each bridge payload.
        for (let start = 0; start < data.length; start += 16_384) {
          const chunk = data.slice(start, start + 16_384);
          client.writes = client.writes.then(() => controller.writeTerminal(client.id, chunk)).catch((failure: unknown) => { if (current === client) error.textContent = message(failure); });
        }
      });
      append(client, snapshot);
      // A session may have been removed while the native shell was opening.
      // Its host context is already closed; do not retain a dead terminal client.
      if (state.selection.sessionId !== undefined && !store.get().sessions.some((session) => session.id === state.selection.sessionId)) {
        clients.delete(context); terminal.dispose();
        await controller.closeTerminal(snapshot.id);
        return;
      }
      if (version === generation && active && isVisible() && viewport.isConnected) { attach(client); terminal.focus(); }
    } catch (failure) { if (version === generation) error.textContent = message(failure); }
    finally { loading = false; renderStatus(); if (version !== generation && active) void open(); }
  }
  function append(client: Client, snapshot: TerminalSnapshot): void {
    const text = `${snapshot.start !== client.offset && client.offset !== 0 ? "\r\n[Earlier terminal output was truncated]\r\n" : ""}${snapshot.output}`;
    // A background shell may finish opening after navigation, so retain its first output until attachment.
    if (client.opened) { if (text) client.terminal.write(text); }
    else client.pendingOutput += text;
    client.offset = snapshot.offset; client.exited = snapshot.exited;
    if (snapshot.exitCode !== undefined) client.exitCode = snapshot.exitCode;
  }
  async function read(): Promise<void> {
    const client = current;
    if (reading || client === undefined || !active || !isVisible() || document.visibilityState === "hidden") return;
    reading = true;
    try { append(client, await controller.readTerminal(client.id, client.offset)); if (current === client) renderStatus(); }
    catch (failure) { if (current === client) { error.textContent = message(failure); client.exited = true; } }
    finally { reading = false; }
  }
  async function closeCurrent(): Promise<void> {
    const client = current; const context = selected;
    if (client === undefined || context === undefined) return;
    try { await controller.closeTerminal(client.id); client.terminal.dispose(); clients.delete(context); if (current === client) { current = undefined; viewport.replaceChildren(); renderStatus(); } }
    catch (failure) { error.textContent = message(failure); }
  }
  store.watch((state) => [state.selection.projectId, state.selection.sessionId, state.host.status, state.sessions], () => {
    const state = store.get(); const next = state.selection.sessionId !== undefined ? `session:${state.selection.sessionId}` : state.selection.projectId === undefined ? undefined : `project:${state.selection.projectId}`;
    // Attaching a chat changes cwd but retains session identity. The host
    // closes its old shell; discard the matching terminal view before reconnecting.
    if (next !== undefined && next === selected && state.selection.projectId !== selectedProjectId) {
      clients.get(next)?.terminal.dispose(); clients.delete(next); current = undefined;
      generation++; viewport.replaceChildren();
    }
    selectedProjectId = state.selection.projectId;
    const retained = new Set(state.sessions.map((session) => `session:${session.id}`));
    for (const [context, client] of clients) {
      if (context.startsWith("session:") && !retained.has(context)) { client.terminal.dispose(); clients.delete(context); }
    }
    if (next !== selected) { generation++; selected = next; current = next === undefined ? undefined : clients.get(next); error.textContent = ""; replace(viewport, current?.element); renderStatus(); }
    if (active) void open();
  });
  let resizeTimer: number | undefined;
  new ResizeObserver(() => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { if (active && !current) void open(); else fit(); }, 80); }).observe(viewport);
  const theme = new MutationObserver(() => { if (current?.opened) { appearance(current); fit(); } });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const syncTheme = () => { if (current?.opened) { appearance(current); fit(); } };
  scheme.addEventListener("change", syncTheme);
  const poll = window.setInterval(() => void read(), 200);
  // beforeunload can be cancelled by native navigation/quit policy. Dispose
  // only after the document actually unloads, or a cancelled close leaves a
  // blank terminal and permanently stops its output polling.
  window.addEventListener("unload", () => { clearInterval(poll); theme.disconnect(); scheme.removeEventListener("change", syncTheme); for (const client of clients.values()) client.terminal.dispose(); });
  renderStatus();
  return { element, setActive(next: boolean) { const opening = next && !active; active = next; if (opening) { void open(); requestAnimationFrame(fit); } } };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
