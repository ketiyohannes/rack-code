/**
 * The waiting-messages stack shown above the composer.
 *
 * The host owns the queue (`SessionView.queue`) and decides when an item
 * starts; this view only renders it and sends `queue.*` commands through the
 * controller. Nothing here is the source of truth, so a reload, another
 * window or a remote controller shows the same stack.
 *
 * Rows are kept by item ID and rebuilt only when their own content changes,
 * so keyboard focus survives unrelated redraws (streaming output refreshes
 * the composer many times a second). The one piece of local state is the
 * inline editor's draft, which never leaves this view until it is saved.
 */
import type { QueuedMessageView, SessionQueueView } from "@rack/contracts";
import type { Controller } from "../controller.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { reconcileChildren } from "../render-cache.js";
import { queueHeading, queuePauseText } from "./queue-format.js";

export interface QueueStackContext {
  readonly sessionId: string;
  readonly queue: SessionQueueView | undefined;
  /** The session has a turn in progress, so "Send now" stops it first. */
  readonly busy: boolean;
  /** Commands cannot be sent (host not ready, another session loading). */
  readonly disabled: boolean;
}

export interface QueueStack {
  readonly element: HTMLElement;
  update(context: QueueStackContext): void;
}

interface RowState {
  readonly signature: string;
  readonly node: HTMLElement;
  /** Applies momentary state (disabled controls, labels) without rebuilding. */
  readonly sync: (context: QueueStackContext, position: number) => void;
}

export function createQueueStack(controller: Controller, focusPrompt: () => void): QueueStack {
  const heading = h("span", { class: "queue-heading" });
  const pause = h("div", { class: "queue-pause", role: "status" });
  const list = h("ol", { class: "queue-items", aria: { label: "Queued messages" } });
  const element = h("section", { class: "message-queue", aria: { label: "Queued messages" } },
    h("div", { class: "queue-head" }, icon("clock"), heading), pause, list);
  element.hidden = true;

  const rows = new Map<string, RowState>();
  /** Item whose text is being edited, with the textarea that holds the draft. */
  let editing: { readonly itemId: string; readonly input: HTMLTextAreaElement } | undefined;
  /** Items with a command in flight; their controls stay disabled until it settles. */
  const pending = new Set<string>();
  let resuming = false;
  let context: QueueStackContext | undefined;

  const redraw = () => { if (context !== undefined) update(context); };
  const resume = h("button", { class: "button button-small queue-resume", type: "button", onClick: async () => {
    if (context === undefined) return;
    const { sessionId } = context;
    resuming = true; redraw();
    try { await controller.resumeQueue(sessionId); } finally { resuming = false; redraw(); }
  } }, icon("play"), "Resume");

  async function run(itemId: string, action: () => Promise<boolean>): Promise<boolean> {
    pending.add(itemId); redraw();
    try { return await action(); } finally { pending.delete(itemId); redraw(); }
  }

  /**
   * A removed row disappears only when the host's `sessions.changed` update
   * arrives. Focus then moves to the row that took its place, or back to the
   * prompt when the stack is empty, instead of falling to the page.
   */
  let refocus: { readonly itemId: string; readonly position: number } | undefined;
  function applyRefocus(items: readonly QueuedMessageView[]): void {
    if (refocus === undefined || items.some((item) => item.id === refocus!.itemId)) return;
    const { position } = refocus;
    refocus = undefined;
    requestAnimationFrame(() => {
      const rowsNow = [...list.querySelectorAll<HTMLElement>(".queue-item")];
      const target = rowsNow[Math.min(position, rowsNow.length - 1)]?.querySelector<HTMLElement>("button:not(:disabled)");
      if (target) target.focus(); else focusPrompt();
    });
  }

  function startEditing(item: QueuedMessageView): void {
    const input = h("textarea", { class: "queue-edit-input", rows: 1, aria: { label: "Edit queued message" } });
    input.value = item.prompt;
    editing = { itemId: item.id, input };
    redraw();
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); autoSize(input); });
  }

  function stopEditing(itemId: string): void {
    if (editing?.itemId !== itemId) return;
    editing = undefined;
    redraw();
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`.queue-item[data-item-id="${CSS.escape(itemId)}"] .queue-edit`)?.focus());
  }

  async function saveEdit(item: QueuedMessageView): Promise<void> {
    if (editing?.itemId !== item.id || context === undefined) return;
    const text = editing.input.value.trim();
    if (text === "" && (item.attachmentIds?.length ?? 0) === 0) return;
    if (text === item.prompt.trim()) { stopEditing(item.id); return; }
    const { sessionId } = context;
    if (await run(item.id, () => controller.updateQueued(sessionId, item.id, text))) stopEditing(item.id);
  }

  /**
   * Builds one row. Disabled states and labels that depend on the moment
   * (a command in flight, a turn running) are applied by the returned
   * `sync`, in place, so a row never has to be rebuilt (and lose focus)
   * just because a button became unavailable for a moment.
   */
  function renderRow(item: QueuedMessageView): RowState {
    const attachments = item.attachmentIds?.length ?? 0;
    let position = 0;
    if (editing?.itemId === item.id) {
      const { input } = editing;
      const save = h("button", { class: "button button-primary button-small", type: "button", onClick: () => void saveEdit(item) }, "Save");
      input.onkeydown = (event) => {
        if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); stopEditing(item.id); }
        else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void saveEdit(item); }
      };
      const node = h("li", { class: "queue-item editing", data: { itemId: item.id } },
        input,
        h("div", { class: "queue-edit-actions" },
          h("span", { class: "note" }, "Enter to save · Esc to cancel"),
          h("button", { class: "button button-small", type: "button", onClick: () => stopEditing(item.id) }, "Cancel"),
          save));
      const sync = (ctx: QueueStackContext, at: number) => {
        position = at;
        input.setAttribute("aria-label", `Edit queued message ${at + 1}`);
        const busy = pending.has(item.id) || ctx.disabled;
        input.readOnly = busy;
        save.disabled = busy || (input.value.trim() === "" && attachments === 0);
      };
      input.oninput = () => { autoSize(input); if (context !== undefined) sync(context, position); };
      return { signature: "", node, sync };
    }
    const indexLabel = h("span", { class: "queue-index", aria: { hidden: "true" } });
    const nextNote = h("span", { class: "queue-meta queue-next", role: "status" }, icon("circle-notch", { className: "spin" }), "Sending next");
    const edit = h("button", { class: "icon-button queue-edit", type: "button", onClick: () => startEditing(item) }, icon("pencil-simple"));
    const send = h("button", { class: "icon-button queue-send", type: "button", onClick: () => {
      if (context !== undefined) { const { sessionId } = context; void run(item.id, () => controller.sendQueuedNow(sessionId, item.id)); }
    } }, icon("paper-plane-right"));
    const remove = h("button", { class: "icon-button queue-remove", type: "button", onClick: async () => {
      if (context === undefined) return;
      const { sessionId } = context;
      const focused = node.contains(document.activeElement);
      if (focused) refocus = { itemId: item.id, position };
      if (!await run(item.id, () => controller.removeQueued(sessionId, item.id)) && refocus?.itemId === item.id) refocus = undefined;
      else if (context !== undefined) applyRefocus(context.queue?.items ?? []);
    } }, icon("trash-simple"));
    const node = h("li", { class: "queue-item", data: { itemId: item.id } },
      indexLabel,
      h("span", { class: "queue-text", title: item.prompt }, item.prompt === "" ? "(attachments only)" : item.prompt),
      attachments === 0 ? null : h("span", { class: "queue-meta", title: `${attachments} attached file${attachments === 1 ? "" : "s"}` }, icon("file-text"), String(attachments)),
      nextNote,
      h("span", { class: "queue-actions" }, edit, send, remove));
    const sync = (ctx: QueueStackContext, at: number) => {
      position = at;
      const index = at + 1;
      indexLabel.textContent = String(index);
      labelled(edit, `Edit queued message ${index}`);
      labelled(remove, `Remove queued message ${index}`);
      const next = ctx.queue?.sendNowItemId === item.id;
      const busy = pending.has(item.id) || ctx.disabled;
      node.classList.toggle("is-next", next);
      nextNote.hidden = !next;
      edit.disabled = busy || next;
      remove.disabled = busy || next;
      send.disabled = busy || ctx.queue?.sendNowItemId !== undefined;
      const label = ctx.busy ? `Stop the current turn and send message ${index} now` : `Send message ${index} now`;
      labelled(send, label);
    };
    return { signature: "", node, sync };
  }

  function update(next: QueueStackContext): void {
    context = next;
    const queue = next.queue;
    const items = queue?.items ?? [];
    element.hidden = items.length === 0;
    // An item that started or was removed elsewhere takes its editor with it.
    if (editing !== undefined && !items.some((item) => item.id === editing!.itemId)) editing = undefined;
    if (items.length === 0) { rows.clear(); replace(list); applyRefocus(items); return; }

    heading.textContent = queueHeading(queue!);
    pause.hidden = queue!.pausedReason === undefined;
    const pauseText = queue!.pausedReason === undefined ? "" : queuePauseText(queue!.pausedReason, queue!.pausedError);
    // Rebuilt only when the reason changes, so a focused Resume button stays focused.
    if (pause.dataset["text"] !== pauseText) {
      pause.dataset["text"] = pauseText;
      replace(pause, ...(pauseText === "" ? [] : [icon("pause"), h("span", {}, pauseText), resume]));
    }
    resume.disabled = resuming || next.disabled;
    resume.title = next.busy ? "Continue with the queue after the current turn" : "Send the next queued message";
    element.classList.toggle("is-paused", queue!.pausedReason !== undefined);

    const seen = new Set<string>();
    const nodes = items.map((item, position) => {
      seen.add(item.id);
      // Position is applied by `sync`, so rows do not rebuild (and replay
      // their enter animation) each time the queue advances.
      const signature = [item.prompt, item.updatedAt, item.attachmentIds?.length ?? 0, editing?.itemId === item.id].join("|");
      let row = rows.get(item.id);
      if (row?.signature !== signature) {
        // Content changed (another window edited it, or it moved up). Keep
        // focus on the same control in the replacement row.
        const old = row?.node;
        const controls = old === undefined ? [] : [...old.querySelectorAll("button, textarea")];
        const focused = controls.indexOf(document.activeElement as Element);
        row = { ...renderRow(item), signature };
        rows.set(item.id, row);
        if (focused >= 0) { const node = row.node; requestAnimationFrame(() => node.querySelectorAll<HTMLElement>("button, textarea")[focused]?.focus()); }
      }
      row.sync(next, position);
      return row.node;
    });
    for (const id of [...rows.keys()]) if (!seen.has(id)) rows.delete(id);
    reconcileChildren(list, nodes);
    applyRefocus(items);
  }

  return { element, update };
}

function labelled(button: HTMLElement, text: string): void {
  if (button.getAttribute("aria-label") === text) return;
  button.setAttribute("aria-label", text);
  button.title = text;
}

function autoSize(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}
