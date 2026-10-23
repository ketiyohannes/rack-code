/**
 * Clipboard action menu and per-session attachment drafts. The controller
 * handles native selection/import; this component only owns presentation.
 * Files chosen during a session switch remain in the original draft.
 */
import type { AttachmentKind } from "@rack/contracts";
import { MAX_ATTACHMENTS, type SessionAttachment } from "@rack/core/sessions/attachments";
import { openPopover, type PopoverHandle } from "../components/popover.js";
import type { Controller } from "../controller.js";
import { h, replace } from "../dom.js";
import { icon, type IconName } from "../icons.js";

const CHOICES: readonly { kind: AttachmentKind; label: string; description: string; icon: IconName }[] = [
  { kind: "images", label: "Images", description: "Photos, screenshots and illustrations", icon: "image" },
  { kind: "documents", label: "Documents", description: "PDFs, documents and spreadsheets", icon: "file-text" },
  { kind: "code", label: "Code and text", description: "Source files, notes and data", icon: "code" },
  { kind: "all", label: "Any file", description: "Browse all formats", icon: "files" },
];

export interface AttachmentPicker {
  readonly trigger: HTMLButtonElement;
  readonly list: HTMLElement;
  readonly busy: boolean;
  files(sessionId: string): readonly SessionAttachment[];
  update(sessionId: string | undefined, disabled: boolean): void;
  /** Removes only the sent snapshot, preserving any later additions. */
  clear(sessionId: string, sentIds: readonly string[]): void;
}

export function createAttachmentPicker(controller: Controller, onChange: () => void): AttachmentPicker {
  const drafts = new Map<string, readonly SessionAttachment[]>();
  let sessionId: string | undefined;
  let disabled = true;
  let busy = false;
  let popover: PopoverHandle | undefined;
  const list = h("div", { class: "attachment-list composer-attachments", aria: { label: "Attached files", live: "polite" } });
  const trigger = h("button", {
    class: "icon-button attachment-trigger", type: "button", title: "Attach files",
    aria: { label: "Attach files", haspopup: "menu", expanded: "false" },
    onClick: () => popover === undefined ? open() : popover.close(),
    onKeydown: (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); open(event.key === "ArrowUp"); }
    },
  }, icon("clipboard"));

  const files = (id: string): readonly SessionAttachment[] => drafts.get(id) ?? [];

  async function choose(kind: AttachmentKind): Promise<void> {
    const destination = sessionId;
    if (destination === undefined || disabled || busy) return;
    popover?.close();
    trigger.focus();
    busy = true;
    onChange();
    try {
      const added = await controller.attachFiles(destination, kind, MAX_ATTACHMENTS - files(destination).length);
      if (added.length > 0) drafts.set(destination, [...files(destination), ...added]);
    } finally {
      busy = false;
      onChange();
    }
  }

  function open(last = false): void {
    if (trigger.disabled || popover !== undefined) return;
    const menu = h("div", { class: "menu attachment-menu", role: "menu", aria: { label: "Attach files" } });
    const items = CHOICES.map((choice) => h("button", {
      class: "menu-item", type: "button", role: "menuitem", onClick: () => void choose(choice.kind),
    }, icon(choice.icon, { className: "menu-icon" }), h("span", { class: "menu-text" },
      h("span", { class: "menu-label" }, choice.label), h("span", { class: "menu-description" }, choice.description))));
    for (const item of items) { item.tabIndex = -1; menu.append(item); }
    menu.addEventListener("keydown", (event) => {
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let next: number | undefined;
      if (event.key === "ArrowDown") next = (index + 1) % items.length;
      if (event.key === "ArrowUp") next = (index + items.length - 1) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
      // Restore focus before closing so Tab can continue from the composer.
      if (event.key === "Tab") { trigger.focus(); popover?.close(); }
    });
    popover = openPopover({ anchor: trigger, content: menu, minWidth: 275, placement: "above", onClose: () => {
      popover = undefined;
      trigger.setAttribute("aria-expanded", "false");
    } });
    trigger.setAttribute("aria-expanded", "true");
    (last ? items.at(-1) : items[0])?.focus();
  }

  function render(): void {
    const selected = sessionId === undefined ? [] : files(sessionId);
    trigger.disabled = disabled || busy || selected.length >= MAX_ATTACHMENTS;
    trigger.title = busy ? "Attaching files…" : selected.length >= MAX_ATTACHMENTS ? `Maximum ${MAX_ATTACHMENTS} attachments` : "Attach files";
    replace(trigger, icon(busy ? "circle-notch" : "clipboard", busy ? { className: "spin" } : {}));
    list.hidden = selected.length === 0;
    replace(list, ...selected.map((file) => h("div", { class: "attachment-chip", title: `${file.name} · ${formatAttachmentSize(file.size)}` },
      icon("file-text"), h("span", { class: "attachment-name" }, file.name),
      h("span", { class: "attachment-size" }, formatAttachmentSize(file.size)),
      h("button", { class: "attachment-remove", type: "button", disabled: disabled || busy,
        aria: { label: `Remove ${file.name}` }, onClick: () => {
          if (sessionId === undefined) return;
          drafts.set(sessionId, files(sessionId).filter((candidate) => candidate.id !== file.id));
          onChange();
          trigger.focus();
        },
      }, icon("x")),
    )));
  }

  render();
  return {
    trigger, list, get busy() { return busy; }, files,
    update(id, unavailable) {
      if (sessionId !== id || unavailable) popover?.close();
      sessionId = id; disabled = unavailable; render();
    },
    clear(id, sentIds) {
      const sent = new Set(sentIds);
      drafts.set(id, files(id).filter((file) => !sent.has(file.id)));
      render();
    },
  };
}

/** Compact byte counts shared by draft chips and persisted turn attachments. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
