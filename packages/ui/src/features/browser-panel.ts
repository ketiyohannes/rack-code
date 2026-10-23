import { browserAddress } from "@rack/features/browser/navigation";
/** Browser chrome lives in the trusted renderer; the actual website is an
 * isolated native view owned by main. Hide that view for app overlays and
 * surface switches, retaining the page for agent use and later reattachment.
 */
import type { BrowserRequest, BrowserSnapshot } from "@rack/features/browser";
import type { Controller } from "../controller.js";
import type { Store } from "../store.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";

export function createBrowserPanel(store: Store, controller: Controller, isVisible: () => boolean) {
  let active = false; let sessionId: string | undefined; let generation = 0;
  let snapshot: BrowserSnapshot | undefined; let busy = false; let addressDirty = false; let lastPresentation = "";
  let actionError: string | undefined;
  let polling = false;
  let actionVersion = 0;
  let queuedNavigation: string | undefined;
  const back = h("button", { class: "icon-button", type: "button", aria: { label: "Browser back" }, onClick: () => void control({ action: "back" }) }, icon("arrow-left"));
  const forward = h("button", { class: "icon-button", type: "button", aria: { label: "Browser forward" }, onClick: () => void control({ action: "forward" }) }, icon("caret-right"));
  const reload = h("button", { class: "icon-button", type: "button", aria: { label: "Reload browser page" }, onClick: () => void control({ action: "reload" }) }, icon("arrow-clockwise"));
  const address = h("input", { type: "text", class: "browser-address", placeholder: "Search or enter address", aria: { label: "Browser address" }, onInput: () => { addressDirty = true; } });
  address.autocomplete = "off"; address.spellcheck = false;
  const agent = h("button", { class: "icon-button browser-agent", type: "button", title: "Pause agent control", aria: { label: "Pause agent control" }, onClick: () => void control({ action: "agent", enabled: snapshot?.agentEnabled === false }) }, icon("hand"));
  const close = h("button", { class: "icon-button", type: "button", title: "Close browser page", aria: { label: "Close browser page" }, onClick: () => void control({ action: "close" }) }, icon("x"));
  const error = h("p", { class: "panel-error", role: "alert" });
  const help = h("div", { class: "browser-empty" }, icon("globe"), h("strong", {}, "New tab"), h("p", {}, "Search or enter an address above. You and the agent share this browser."));
  const slot = h("div", { class: "browser-viewport", aria: { label: "Shared browser page" } }, help);
  const form = h("form", { class: "browser-toolbar", aria: { label: "Browser navigation" }, onSubmit: (event) => {
    event.preventDefault();
    try { const url = browserAddress(address.value); addressDirty = false; if (busy) queuedNavigation = url; else void control({ action: "navigate", url }); }
    catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
  } }, back, forward, reload, address, agent, close);
  const element = h("div", { class: "browser-panel" }, form, error, slot);

  function render(): void {
    back.disabled = busy || !snapshot?.canGoBack; forward.disabled = busy || !snapshot?.canGoForward;
    reload.disabled = busy || !snapshot?.url;
    address.disabled = sessionId === undefined;
    agent.disabled = busy || sessionId === undefined; close.disabled = busy || sessionId === undefined;
    const agentLabel = snapshot?.agentEnabled === false ? "Resume agent control" : "Pause agent control";
    agent.title = agentLabel; agent.setAttribute("aria-label", agentLabel);
    agent.setAttribute("aria-pressed", String(snapshot?.agentEnabled === false));
    reload.classList.toggle("spin", snapshot?.loading === true);
    address.title = snapshot?.title ? `${snapshot.title}\n${snapshot.url}` : "Search or enter address";
    slot.setAttribute("aria-label", snapshot?.title || "Shared browser page");
    if (!addressDirty && !busy && !snapshot?.loading && address.value !== (snapshot?.url ?? "")) address.value = snapshot?.url ?? "";
    help.hidden = !!snapshot?.url || !!snapshot?.loading;
    slot.setAttribute("aria-busy", String(snapshot?.loading === true));
    schedulePresentation();
  }
  async function control(request: BrowserRequest): Promise<void> {
    const background = request.action === "state";
    if (sessionId === undefined || store.get().host.status !== "ready" || busy || (background && polling)) return;
    const target = sessionId; const version = generation;
    // Polling must neither disable toolbar controls nor swallow an Enter/Go
    // submitted while a state response is in flight. An action supersedes
    // older state reads so they cannot restore its previous URL or title.
    if (background) polling = true;
    else { busy = true; actionVersion++; if (request.action === "navigate") address.value = request.url ?? ""; render(); }
    const revision = actionVersion;
    try {
      const value = await controller.controlBrowser(target, request);
      if (version !== generation || (background && revision !== actionVersion)) return;
      if (request.action !== "state") actionError = undefined;
      snapshot = value; error.textContent = value.error ?? actionError ?? "";
      if (request.action === "navigate") { address.value = request.url ?? ""; addressDirty = false; }
    } catch (failure) {
      if (version === generation && (!background || revision === actionVersion)) {
        const detail = failure instanceof Error ? failure.message : String(failure);
        if (request.action !== "state") actionError = detail;
        if (request.action === "navigate") addressDirty = true;
        error.textContent = detail;
      }
    }
    finally {
      if (background) polling = false; else busy = false;
      if (version === generation) {
        render();
        // Keep the most recent submitted address while a navigation owns the
        // transport lane; never silently drop Enter during a slow page load.
        if (!background && queuedNavigation !== undefined) {
          const url = queuedNavigation; queuedNavigation = undefined;
          void control({ action: "navigate", url });
        }
      }
      // Session changes can occur while a request owns the single transport
      // lane. Load the new page immediately once the old reply is discarded.
      else if (active && store.get().host.status === "ready") void control({ action: "state" });
    }
  }
  let scheduled = false;
  function schedulePresentation(): void {
    if (scheduled) return; scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const overlay = document.documentElement.classList.contains("resizing") || document.querySelector(".modal-backdrop, .popover, .settings-overlay:not([hidden])") !== null;
      const visible = active && isVisible() && store.get().host.status === "ready" && document.visibilityState !== "hidden" && !overlay && slot.isConnected && sessionId !== undefined && (!!snapshot?.url || !!snapshot?.loading);
      const rect = slot.getBoundingClientRect();
      const request = { visible, ...(sessionId === undefined ? {} : { sessionId }), ...(visible ? { bounds: { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) } } : {}) };
      const encoded = JSON.stringify(request); if (lastPresentation === encoded) return; lastPresentation = encoded;
      void controller.presentBrowser(request).catch((failure: unknown) => { lastPresentation = ""; if (active) error.textContent = failure instanceof Error ? failure.message : String(failure); });
    });
  }
  store.watch((state) => [state.selection.sessionId, state.host.status], () => {
    const next = store.get().selection.sessionId;
    if (next !== sessionId) { sessionId = next; generation++; snapshot = undefined; queuedNavigation = undefined; actionError = undefined; addressDirty = false; address.value = ""; error.textContent = ""; render(); }
    if (active && store.get().host.status === "ready") void control({ action: "state" });
  });
  const stopAddressFocus = controller.onBrowserAddressFocus(() => {
    if (!document.querySelector(".modal-backdrop, .popover, .settings-overlay:not([hidden])") && active && isVisible() && sessionId !== undefined) { address.focus(); address.select(); }
  });
  new ResizeObserver(schedulePresentation).observe(slot);
  window.addEventListener("layout-resize", schedulePresentation);
  const overlays = new MutationObserver(schedulePresentation);
  overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style"] });
  window.addEventListener("resize", schedulePresentation);
  document.addEventListener("keydown", (event) => {
    if (!event.defaultPrevented && !document.querySelector(".modal-backdrop, .popover, .settings-overlay:not([hidden])") && active && isVisible() && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault(); address.focus(); address.select();
    }
  });
  document.addEventListener("visibilitychange", schedulePresentation);
  const poll = window.setInterval(() => { if (active && isVisible() && document.visibilityState !== "hidden") void control({ action: "state" }); }, 500);
  window.addEventListener("unload", () => { clearInterval(poll); overlays.disconnect(); stopAddressFocus(); });
  render();
  return { element, setActive(next: boolean) { const opening = next && !active; active = next; if (opening) void control({ action: "state" }); schedulePresentation(); } };
}
