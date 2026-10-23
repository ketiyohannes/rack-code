/**
 * Delegated context menus for readable app content. A binding is installed
 * once per root; re-rendering updates its factory and invalidates old actions.
 * Inputs keep normal editing behavior. Selection and text are captured before
 * focus moves to the menu, so actions cannot accidentally read another panel.
 */
import { h } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { openPopover, type PopoverHandle } from "./popover.js";

export interface ContentTarget {
  readonly selection: string;
  readonly text: string;
  readonly link?: string;
}
export interface ContextAction {
  readonly label: string;
  readonly icon: IconName;
  readonly disabled?: boolean;
  readonly run: () => void | Promise<void>;
}
type Factory = (target: ContentTarget) => readonly (ContextAction | null)[];
interface Binding { factory: Factory; menu?: PopoverHandle | undefined }
const bindings = new WeakMap<HTMLElement, Binding>();

/** Null items separate action groups. Common copy actions follow the caller's actions. */
export function bindContentMenu(root: HTMLElement, factory: Factory): () => void {
  const existing = bindings.get(root);
  if (existing) { existing.menu?.close(); existing.factory = factory; return () => existing.menu?.close(); }
  const binding: Binding = { factory };
  bindings.set(root, binding);
  // Scrollable reading regions must also be reachable for Shift+F10.
  if (!root.hasAttribute("tabindex")) root.tabIndex = 0;
  const show = (event: MouseEvent | KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : root;
    if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), button, [role="button"]')) return;
    const selection = window.getSelection();
    const selected = selection?.anchorNode && selection.focusNode && root.contains(selection.anchorNode) && root.contains(selection.focusNode)
      ? selection.toString().trim() : "";
    // Empty space offers actions without collecting the entire transcript or
    // diff. Only the clicked reading block is eligible for Copy text.
    const block = target.closest(".md, .bubble-text, .activity-section, pre, p, h1, h2, h3");
    const link = target.closest<HTMLAnchorElement>("a[href]")?.href;
    const content: ContentTarget = { selection: selected, text: selected || (block?.textContent ?? "").trim(), ...(link ? { link } : {}) };
    const actions = [...binding.factory(content)];
    if (selected || content.text || link) {
      if (actions.length) actions.push(null);
      const text = selected || content.text;
      if (text) actions.push({ label: selected ? "Copy selection" : "Copy text", icon: "copy", run: () => navigator.clipboard.writeText(text) });
      if (link) actions.push({ label: "Copy link", icon: "copy", run: () => navigator.clipboard.writeText(link) });
    }
    if (!actions.some(Boolean)) return;
    event.preventDefault(); event.stopPropagation();
    const rect = target.getBoundingClientRect();
    const point = event instanceof MouseEvent && (event.clientX || event.clientY)
      ? { x: event.clientX, y: event.clientY } : { x: rect.left + 12, y: rect.top + 24 };
    const menu = h("div", { class: "menu content-context-menu", role: "menu", aria: { label: "Content actions" } });
    const status = h("div", { class: "context-menu-status note", role: "status" }); status.hidden = true;
    const picker = openPopover({ anchor: root, point, content: menu, minWidth: 230, maxWidth: 290, onClose: () => { binding.menu = undefined; } });
    binding.menu = picker;
    for (const action of actions) {
      if (!action) { menu.append(h("div", { class: "menu-divider", role: "separator" })); continue; }
      menu.append(h("button", { class: "menu-item", type: "button", role: "menuitem", disabled: action.disabled ?? false, onClick: () => {
        // Streaming may replace the clicked node. Captured text remains valid;
        // navigation/rebinding closes the menu, and hidden roots cannot act.
        if (!root.isConnected || root.getClientRects().length === 0) { picker.close(); return; }
        try {
          Promise.resolve(action.run()).then(() => picker.close()).catch(() => {
            status.textContent = "Could not complete this action. Try again."; status.hidden = false; picker.reposition();
          });
        } catch { status.textContent = "Could not complete this action. Try again."; status.hidden = false; picker.reposition(); }
      } }, icon(action.icon), h("span", {}, action.label)));
    }
    menu.append(status); picker.reposition();
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    items[0]?.focus({ preventScroll: true });
    menu.addEventListener("keydown", (key) => {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = key.key === "Home" ? 0 : key.key === "End" ? items.length - 1
        : key.key === "ArrowDown" ? (index + 1) % items.length : key.key === "ArrowUp" ? (index + items.length - 1) % items.length : undefined;
      if (next !== undefined) { key.preventDefault(); key.stopPropagation(); items[next]?.focus({ preventScroll: true }); }
      if (key.key === "Tab") { picker.close(); root.focus({ preventScroll: true }); }
    });
  };
  root.addEventListener("contextmenu", show);
  root.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) show(event);
  });
  return () => binding.menu?.close();
}
