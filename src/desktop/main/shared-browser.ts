import { IPC_CHANNELS } from "../../contracts/desktop/transport.js";
import { browserViewBounds } from "./browser-bounds.js";
import { WebContentsView, type BrowserWindow } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { browserUrl, type BrowserPresentation, type BrowserRequest, type BrowserSnapshot } from "../../features/browser/index.js";

interface Tab { view: WebContentsView; owner?: BrowserWindow; agentEnabled: boolean; error?: string }

/** Owns the actual pages, independently of surface attachment and model runs.
 * Each session has a separate in-memory Chromium profile and a sandboxed view
 * with no preload/Node bridge. DOM automation runs in an isolated world, so
 * websites cannot replace the reference map used by the agent's controls.
 */
export class SharedBrowser {
  private readonly tabs = new Map<string, Tab>();

  async control(sessionId: string, request: BrowserRequest): Promise<BrowserSnapshot> {
    if (request.actor === "agent" && ["agent", "close"].includes(request.action)) throw new Error("Only the user can pause, resume or close the shared browser.");
    if (request.action === "close") { this.close(sessionId); return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, agentEnabled: true }; }
    // Polling an unopened conversation must not allocate a Chromium view.
    if (request.action === "state" && !this.tabs.has(sessionId)) return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, agentEnabled: true };
    // Reject bad addresses before allocating a view. Otherwise repeated
    // invalid submissions consume slots without opening a usable page.
    if (request.action === "navigate" && request.url === undefined) throw new Error("Enter a browser address.");
    const targetUrl = request.action === "navigate" ? browserUrl(request.url!) : undefined;
    const tab = this.tab(sessionId);
    if (request.actor === "agent" && !tab.agentEnabled) throw new Error("Agent browser control is paused. Ask the user to resume it.");
    const page = tab.view.webContents;
    if (["navigate", "back", "forward", "reload"].includes(request.action)) delete tab.error;
    if (request.action === "agent") tab.agentEnabled = request.enabled === true;
    if (request.action === "navigate") {
      void page.loadURL(targetUrl!).catch((error: unknown) => { tab.error = error instanceof Error ? error.message : String(error); });
    }
    if (request.action === "back" && page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
    if (request.action === "forward" && page.navigationHistory.canGoForward()) page.navigationHistory.goForward();
    if (request.action === "reload") page.reload();
    let text: string | undefined;
    if (["snapshot", "click", "type", "select", "press", "scroll"].includes(request.action)) {
      if (!tab.agentEnabled) throw new Error("Agent browser control is paused. Ask the user to resume it.");
      if (["click", "type", "select", "press"].includes(request.action)) {
        // Detached WebContentsViews otherwise refuse DOM focus, even when
        // CDP dispatches input directly. Emulate focus without activating or
        // stealing keyboard focus from the user's application window.
        if (!page.debugger.isAttached()) page.debugger.attach("1.3");
        await page.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      }
      if (["click", "type", "select"].includes(request.action)) {
        const args = JSON.stringify({ ref: request.ref, text: request.text, action: request.action });
        // Electron replaces exceptions across isolated-world boundaries with
        // a generic message. Return expected action failures as plain data so
        // the agent can recover from stale refs and invalid controls.
        const actionResult = await page.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => { try {
          const args = ${args}; const element = globalThis.__rackElements?.get(args.ref);
          if (!element || !element.isConnected) throw new Error('Stale element reference. Take a new snapshot.');
          element.scrollIntoView({block:'center'});
          element.focus();
          if (args.action === 'click') { if (element.disabled) throw new Error('Element is disabled.'); element.click(); }
          else if (args.action === 'select') {
            if (!(element instanceof HTMLSelectElement) || element.disabled) throw new Error('Choose an enabled select control.');
            if (![...element.options].some(option => option.value === args.text && !option.disabled)) throw new Error('Choose an available option value.');
            element.value = args.text;
            element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true}));
          }
          else {
            if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) || ['file','checkbox','radio'].includes(element.type)) throw new Error('Choose an editable text field.');
            if (element.disabled || element.readOnly) throw new Error('Field is not editable.');
            const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,args.text ?? '');
            element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true}));
          }
        } catch (error) { return {error: error instanceof Error ? error.message : String(error)}; } })()` }], true) as { error?: string } | undefined;
        if (actionResult?.error !== undefined) throw new Error(actionResult.error);
      }
      if (request.action === "press") {
        const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Delete: 46, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
        const code = request.text ?? "";
        const virtualKey = codes[code];
        if (virtualKey === undefined) throw new Error("Choose Enter, Tab, Escape, Space or an arrow/navigation key.");
        // Native sendInputEvent requires an attached/focused window. CDP
        // targets this page directly, so the agent can also use a hidden tab
        // while the user keeps chatting or works in another surface.
        if (!page.debugger.isAttached()) page.debugger.attach("1.3");
        const key = code === "Space" ? " " : code;
        const params = { key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey };
        await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...params,
          ...(code === "Enter" ? { text: "\r", unmodifiedText: "\r" } : code === "Space" ? { text: " ", unmodifiedText: " " } : {}) });
        await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...params });
      }
      if (request.action === "scroll") await page.executeJavaScriptInIsolatedWorld(999, [{ code: `window.scrollBy(${request.x ?? 0},${request.y ?? 500})` }]);
      // New references replace previous snapshots. Names omit field values,
      // especially passwords; page text is bounded and remains untrusted data.
      text = await page.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
        const generation = ${JSON.stringify(randomUUID())};
        const elements = new Map(); globalThis.__rackElements = elements;
        const rows = []; let count = 0; let length = 0;
        for (const element of document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"]')) {
          if (count >= 200) break;
          const bounds = element.getBoundingClientRect(); if (!bounds.width || !bounds.height || getComputedStyle(element).visibility === 'hidden') continue;
          const ref = generation + ':' + (++count); elements.set(ref,element);
          const name = element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.innerText || element.getAttribute('placeholder') || element.getAttribute('name') || element.tagName;
          const options = element instanceof HTMLSelectElement ? ' options: '+JSON.stringify([...element.options].slice(0,50).map(option => ({value:option.value.slice(0,160),label:option.label.slice(0,160),disabled:option.disabled,truncated:option.value.length>160}))) : '';
          const row = '['+ref+'] '+element.tagName.toLowerCase()+' '+String(name).trim().slice(0,160)+(element.disabled?' (disabled)':'')+options;
          if (length + row.length > 40000) { rows.push('Additional controls omitted: snapshot limit reached.'); break; }
          length += row.length; rows.push(row);
        }
        return 'Page: '+document.title+'\\nURL: '+location.href+'\\n\\n'+(document.body?.innerText ?? '').slice(0,20000)+'\\n\\nControls:\\n'+rows.join('\\n');
      })()` }]);
    }
    return { url: page.getURL(), title: page.getTitle(), loading: page.isLoading(), canGoBack: page.navigationHistory.canGoBack(),
      canGoForward: page.navigationHistory.canGoForward(), agentEnabled: tab.agentEnabled,
      ...(text === undefined ? {} : { page: text }), ...(tab.error === undefined ? {} : { error: tab.error }) };
  }

  /** A view can belong to one window at a time. Hiding/detaching it keeps its
   * page alive for a run; overlays hide it so it cannot cover app dialogs.
   */
  present(owner: BrowserWindow, request: BrowserPresentation): void {
    for (const [id, tab] of this.tabs) {
      if (tab.owner === owner && (!request.visible || id !== request.sessionId)) this.detach(tab);
    }
    if (!request.visible || request.sessionId === undefined || request.bounds === undefined) return;
    const tab = this.tabs.get(request.sessionId);
    if (tab === undefined) return;
    if (tab.owner !== owner) { this.detach(tab); owner.contentView.addChildView(tab.view); tab.owner = owner; }
    tab.view.setBounds(browserViewBounds(request.bounds, owner.getContentSize(), owner.webContents.getZoomFactor()));
    tab.view.setVisible(true);
  }

  close(sessionId: string): void { const tab = this.tabs.get(sessionId); if (tab === undefined) return; this.detach(tab); tab.view.webContents.close(); this.tabs.delete(sessionId); }
  shutdown(): void { for (const id of this.tabs.keys()) this.close(id); }
  private detach(tab: Tab): void { if (tab.owner !== undefined && !tab.owner.isDestroyed()) tab.owner.contentView.removeChildView(tab.view); delete tab.owner; tab.view.setVisible(false); }
  private tab(sessionId: string): Tab {
    const existing = this.tabs.get(sessionId); if (existing !== undefined) return existing;
    if (this.tabs.size >= 12) throw new Error("Close an existing browser before opening another (12 maximum).");
    const partition = `rack-browser-${createHash("sha256").update(sessionId).digest("hex")}`;
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, safeDialogs: true, backgroundThrottling: false } });
    const tab: Tab = { view, agentEnabled: true };
    // Website contents have no preload. Route this user keyboard shortcut to
    // the owning trusted renderer without exposing its bridge to the page.
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && (input.control || input.meta) && input.key.toLowerCase() === "l" && tab.owner) {
        event.preventDefault(); tab.owner.webContents.focus();
        tab.owner.webContents.send(IPC_CHANNELS.focusBrowserAddress);
      }
    });
    const allowed = (url: string) => { try { return url === "about:blank" || browserUrl(url) === new URL(url).href; } catch { return false; } };
    view.webContents.on("will-navigate", (event, url) => { if (!allowed(url)) event.preventDefault(); });
    view.webContents.on("will-frame-navigate", (event) => { if (!allowed(event.url)) event.preventDefault(); });
    view.webContents.on("will-redirect", (event, url) => { if (!allowed(url)) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(({ url }) => { if (allowed(url) && url !== "about:blank") void view.webContents.loadURL(url).catch(() => {}); return { action: "deny" }; });
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.on("will-download", (event) => event.preventDefault());
    view.webContents.on("render-process-gone", () => { tab.error = "This page stopped responding. Reload it to continue."; });
    view.webContents.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (mainFrame && code !== -3) tab.error = description;
    });
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 1024, height: 768 });
    this.tabs.set(sessionId, tab);
    return tab;
  }
}
