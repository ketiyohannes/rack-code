/** Shared project/file editor menu. Resolve the target when opening the menu
 * so navigation during native discovery cannot retarget an eventual click.
 */
import type { Controller } from "../controller.js";
import type { OpenPathRequest } from "@rack/contracts/transport";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openPopover, type PopoverHandle } from "./popover.js";

export function createOpenInButton(controller: Controller, target: () => Promise<OpenPathRequest>): HTMLButtonElement {
  let menu: PopoverHandle | undefined;
  const button = h("button", { class: "icon-button open-in-button", type: "button", title: "Open in editor", aria: { label: "Open in editor", haspopup: "menu", expanded: "false" }, onClick: () => {
    if (menu) { menu.close(); return; }
    const content = h("div", { class: "menu open-in-menu", role: "menu" }, h("p", { class: "note" }, "Finding installed editors…"));
    let closed = false;
    menu = openPopover({ anchor: button, content, minWidth: 220, align: "end", onClose: () => { closed = true; menu = undefined; button.setAttribute("aria-expanded", "false"); } });
    button.setAttribute("aria-expanded", "true");
    const item = (text: string, action: () => void) => h("button", { class: "menu-item", type: "button", role: "menuitem", onClick: () => { menu?.close(); action(); } }, text);
    void Promise.all([target(), controller.listEditors()]).then(([path, editors]) => {
      if (closed || !button.isConnected) { menu?.close(); return; }
      replace(content,
        ...editors.map((editor) => item(editor.label, () => void controller.openInEditor(editor.id, path))),
        ...(editors.length ? [] : [h("p", { class: "note" }, "No editors detected.")]),
        item("Choose application…", () => void controller.openInEditor("choose", path)),
        h("div", { class: "menu-divider", role: "separator" }),
        item("Default application", () => void controller.openPath(path.path, path.base)),
      );
      menu?.reposition();
    }).catch(() => { if (!closed) replace(content, h("p", { class: "note", role: "alert" }, "Could not load editors. Close and try again.")); });
  } }, icon("code"));
  return button;
}
