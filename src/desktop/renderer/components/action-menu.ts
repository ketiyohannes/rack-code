/**
 * Compact command menu anchored to a button or a pointer position, used for
 * the Changes panel's repository, commit, branch and file actions.
 *
 * `null` entries render separators. Arrow keys, Home and End move between
 * enabled items; Tab closes the menu and returns focus to the anchor, and
 * Escape/outside clicks close it through the shared popover. Items run after
 * the menu closes, so an action that opens a dialog gets focus cleanly.
 */
import { h } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { openPopover, type PopoverHandle } from "./popover.js";

export interface ActionMenuItem {
  readonly label: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  /** Destructive actions (discard) are styled as such. */
  readonly danger?: boolean;
  /** Tooltip, for example why an item is disabled. */
  readonly title?: string;
  readonly run: () => void;
}

export interface ActionMenuOptions {
  readonly anchor: HTMLElement;
  readonly label: string;
  readonly items: readonly (ActionMenuItem | null)[];
  /** Pointer position for right-click menus. */
  readonly point?: { readonly x: number; readonly y: number };
  readonly align?: "start" | "end";
}

export function openActionMenu(options: ActionMenuOptions): PopoverHandle {
  const menu = h("div", { class: "menu action-menu", role: "menu", aria: { label: options.label } });
  const popover = openPopover({ anchor: options.anchor, content: menu, minWidth: 220, maxWidth: 300, align: options.align ?? "end",
    ...(options.point === undefined ? {} : { point: options.point }) });
  // Collapse leading, trailing and repeated separators left by hidden items.
  const entries = options.items.filter((item, index, all) => item !== null || (index > 0 && all[index - 1] !== null && index < all.length - 1));
  for (const item of entries) {
    if (item === null) { menu.append(h("div", { class: "menu-divider", role: "separator" })); continue; }
    menu.append(h("button", {
      class: `menu-item${item.danger ? " danger" : ""}`, type: "button", role: "menuitem", disabled: item.disabled ?? false,
      ...(item.title === undefined ? {} : { title: item.title }),
      onClick: () => { popover.close(); options.anchor.focus({ preventScroll: true }); item.run(); },
    }, item.icon === undefined ? null : icon(item.icon), h("span", {}, item.label)));
  }
  popover.reposition();
  const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  items[0]?.focus({ preventScroll: true });
  menu.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : undefined;
    if (next !== undefined) { event.preventDefault(); event.stopPropagation(); items[next]?.focus({ preventScroll: true }); }
    if (event.key === "Tab") { event.preventDefault(); popover.close(); options.anchor.focus({ preventScroll: true }); }
  });
  return popover;
}
