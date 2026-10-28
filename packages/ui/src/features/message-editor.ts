/**
 * Inline editor for an earlier message of the conversation.
 *
 * Saving is destructive in a specific, limited way: the edited turn and every
 * later turn leave the conversation (their journals stay for audit) and the
 * edited message runs as a new turn. Files those turns changed are not
 * reverted. The editor states both consequences next to the Save button
 * before any keystroke, so the button itself is the confirmation.
 *
 * The element is created once per edit and kept by the session view across
 * redraws, so streaming elsewhere never resets the draft, caret or focus.
 */
import { h } from "../dom.js";
import { icon } from "../icons.js";

export interface MessageEditorOptions {
  readonly runId: string;
  readonly prompt: string;
  readonly attachmentCount: number;
  /** Resolves true when the edit was accepted; the editor then closes. */
  readonly save: (prompt: string) => Promise<boolean>;
  readonly cancel: () => void;
}

export interface MessageEditor {
  readonly element: HTMLElement;
  readonly runId: string;
  focus(): void;
  /**
   * Refreshes what depends on the rest of the conversation: how many turns a
   * save replaces, and why saving is unavailable right now (a turn running).
   */
  update(replaced: number, blockedReason: string | undefined): void;
}

let sequence = 0;

export function createMessageEditor(options: MessageEditorOptions): MessageEditor {
  const warningId = `message-editor-warning-${++sequence}`;
  const input = h("textarea", { class: "message-editor-input", rows: 1, aria: { label: "Edit message", describedby: warningId } });
  input.value = options.prompt;
  const warningText = h("span");
  const warning = h("p", { class: "message-editor-warning", id: warningId }, icon("warning-circle"), warningText);
  const cancel = h("button", { class: "button button-small", type: "button", onClick: () => options.cancel() }, "Cancel");
  const save = h("button", { class: "button button-primary button-small", type: "submit" }, "Save and resend");
  let saving = false;
  let blocked: string | undefined;
  const element = h("form", {
    class: "message-editor", aria: { label: "Edit message" }, data: { runId: options.runId },
    onSubmit: (event) => { event.preventDefault(); void submit(); },
  },
    input,
    warning,
    h("div", { class: "message-editor-actions" }, cancel, save));

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      // Handled here so the composer's Escape (stop the run) never sees it.
      event.preventDefault(); event.stopPropagation();
      if (!saving) options.cancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
  input.addEventListener("input", () => { autoSize(); sync(); });

  function empty(): boolean {
    return input.value.trim() === "" && options.attachmentCount === 0;
  }

  function sync(): void {
    save.disabled = saving || blocked !== undefined || empty();
    save.title = blocked ?? (empty() ? "Type a message to resend" : "Replace this turn and resend (Enter)");
    cancel.disabled = saving;
    input.readOnly = saving;
    element.setAttribute("aria-busy", String(saving));
    save.textContent = saving ? "Resending…" : "Save and resend";
  }

  async function submit(): Promise<void> {
    if (saving || blocked !== undefined || empty()) return;
    saving = true; sync();
    let accepted = false;
    try { accepted = await options.save(input.value.trim()); } finally {
      saving = false;
      // An accepted edit removes this turn, and the view drops the editor.
      if (!accepted) { sync(); input.focus(); }
    }
  }

  function autoSize(): void {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 320)}px`;
  }

  return {
    element,
    runId: options.runId,
    focus: () => {
      requestAnimationFrame(() => {
        autoSize();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    },
    update: (replaced, blockedReason) => {
      blocked = blockedReason;
      const later = replaced - 1;
      const turns = later <= 0 ? "Resending replaces this turn" : `Resending replaces this turn and ${later} later turn${later === 1 ? "" : "s"}`;
      const files = later <= 0 ? "Files it changed are not reverted." : "Files they changed are not reverted.";
      const attached = options.attachmentCount === 0 ? "" : ` ${options.attachmentCount === 1 ? "Its attachment is" : `Its ${options.attachmentCount} attachments are`} sent again.`;
      warningText.textContent = blockedReason ?? `${turns}. ${files}${attached}`;
      warning.classList.toggle("is-blocked", blockedReason !== undefined);
      sync();
    },
  };
}
