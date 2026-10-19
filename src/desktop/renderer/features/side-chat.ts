/**
 * Side chat: a secondary conversation beside the main session or a PR review.
 *
 * Design (see docs/side-chat.md):
 * - A side chat is an ordinary standalone chat session (no `projectId`). The
 *   project writer lock is only taken for project sessions, so a side chat can
 *   run while the main session's agent is editing the project. Runs always use
 *   `read_only` permissions: a side chat can read files but never changes them.
 * - Each context (a main session, a PR) has its own side chat. The mapping from
 *   context key to session ID is a per-device renderer preference
 *   (`localStorage`); no core record changes. Clearing starts a new session and
 *   removes the old one.
 * - Context is sent as hidden text appended to the prompt after
 *   `CONTEXT_MARKER`. The panel shows only the user's text; the model sees both.
 *   `SideChatContext.context` decides what to send on each turn.
 * - Streaming reuses the controller's live-run events (`state.live`), which are
 *   keyed by run ID for every session. When a run leaves `live`, the panel
 *   re-reads its runs and messages from the host, because the store only keeps
 *   finished transcripts for the selected main session.
 */
import type { RunView, SessionMessageView } from "../../../contracts/desktop/index.js";
import type { Controller } from "../controller.js";
import type { HostClient } from "../host-client.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import type { Store } from "../store.js";
import { foldEvents } from "../transcript.js";
import { createModelPicker } from "../components/model-picker.js";
import { createResizeHandle } from "../components/resize-handle.js";
import { isActiveStatus } from "./run-format.js";
import { sideChatPrompt, visiblePrompt } from "./side-chat-prompt.js";
export { CONTEXT_MARKER, MAX_CONTEXT_CHARS } from "./side-chat-prompt.js";

const STORAGE_KEY = "sideChat.sessions";

export interface SideChatSuggestion { readonly label: string; readonly prompt: string; readonly icon: IconName }
export interface SideChatContext {
  /** Stable identity, e.g. `session:<id>` or `pr:<host>/<repo>#<n>`. */
  readonly key: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly emptyHint: string;
  readonly suggestions?: readonly SideChatSuggestion[];
  /** Hidden context for the next prompt; `firstTurn` is true for a new side chat. */
  context(firstTurn: boolean): string | undefined | Promise<string | undefined>;
}
export interface SideChat {
  readonly element: HTMLElement;
  /** Switches the panel to another context (or none); in-flight runs keep streaming into their own chat. */
  setContext(context: SideChatContext | undefined): void;
  /** Sends a prompt as if typed, e.g. from an "Explain with AI" action. */
  send(prompt: string): Promise<void>;
  focus(): void;
}

function loadSessions(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    return value !== null && typeof value === "object" ? value as Record<string, string> : {};
  } catch { return {}; }
}
function saveSession(key: string, sessionId: string | undefined): void {
  const sessions = loadSessions();
  if (sessionId === undefined) delete sessions[key]; else sessions[key] = sessionId;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); } catch { /* The chat still works for this window. */ }
}

/** Docked width bounds; the review keeps at least MIN_REVIEW_WIDTH beside it. */
const DOCK_DEFAULT = 460, DOCK_MIN = 340, MIN_REVIEW_WIDTH = 520, DOCK_WIDTH_KEY = "layout.side-chat-width";

export function createSideChat(store: Store, controller: Controller, host: HostClient, options: { readonly onClose?: () => void; readonly resizable?: boolean } = {}): SideChat {
  let context: SideChatContext | undefined;
  let sessionId: string | undefined;
  let runs: readonly RunView[] = [];
  let messages: readonly SessionMessageView[] = [];
  let sending = false, loadError: string | undefined, generation = 0;
  let seenLive = new Set<string>();

  const title = h("strong", { class: "side-chat-title" });
  const subtitle = h("span", { class: "side-chat-subtitle note" });
  const clear = h("button", { class: "icon-button", type: "button", title: "New side chat", aria: { label: "New side chat" }, onClick: () => void reset() }, icon("arrow-counter-clockwise"));
  const close = options.onClose ? h("button", { class: "icon-button", type: "button", title: "Close side chat", aria: { label: "Close side chat" }, onClick: options.onClose }, icon("x")) : null;
  const transcript = h("div", { class: "side-chat-transcript", aria: { live: "polite" } });
  const input = h("textarea", { class: "side-chat-input", rows: 3, placeholder: "Ask a side question…", aria: { label: "Side chat message" } });
  const model = createModelPicker(() => renderComposer(), () => controller.openSettings("models"));
  const submit = h("button", { class: "icon-button icon-button-primary side-chat-send", type: "button" });
  const hint = h("p", { class: "side-chat-hint note" });
  const element = h("section", { class: "side-chat", aria: { label: "Side chat" } },
    h("header", { class: "side-chat-header" }, h("span", { class: "side-chat-icon" }, icon("chat-circle-text")),
      h("div", { class: "side-chat-heading" }, title, subtitle), clear, close),
    transcript,
    h("div", { class: "side-chat-composer" }, input, h("div", { class: "side-chat-actions" }, h("span", { class: "side-chat-mode note", title: "Side chats can read files but never change them." }, icon("lock-simple"), "Read-only"), model.element, submit), hint));

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submitInput(); }
  });
  input.addEventListener("input", () => renderComposer());
  if (options.resizable) attachDockResize(element);
  // Escape inside the side chat stops only the side chat's reply. Marking the
  // event handled keeps the main composer's document-level Escape from
  // cancelling the main session's run.
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || document.querySelector(".popover, .modal-backdrop")) return;
    event.preventDefault();
    const running = activeRun();
    if (running && !running.cancelRequested) void controller.cancelRun(running.run.id);
  });

  const activeRun = () => Object.values(store.get().live).find((live) => live.run.sessionId === sessionId && sessionId !== undefined && isActiveStatus(live.run.status));

  async function load(): Promise<void> {
    const version = ++generation;
    if (sessionId === undefined) { runs = []; messages = []; render(); return; }
    try {
      const [loadedRuns, session] = await Promise.all([host.call("runs.list", { sessionId }), host.call("sessions.get", { sessionId })]);
      if (version !== generation) return;
      runs = loadedRuns; messages = session.messages; loadError = undefined;
    } catch {
      if (version !== generation) return;
      // The saved session was removed elsewhere; start fresh on the next message.
      if (context) saveSession(context.key, undefined);
      sessionId = undefined; runs = []; messages = [];
    }
    render();
  }

  async function reset(): Promise<void> {
    if (!context || activeRun()) return;
    const previous = sessionId;
    saveSession(context.key, undefined);
    sessionId = undefined; runs = []; messages = []; render();
    if (previous) void host.call("sessions.remove", { sessionId: previous }).catch(() => undefined);
    input.focus();
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const created = await host.call("sessions.create", { title: `Side chat · ${context?.title ?? "Rack"}` });
    sessionId = created.id;
    if (context) saveSession(context.key, created.id);
    return created.id;
  }

  async function send(text: string): Promise<void> {
    const prompt = text.trim();
    const selected = model.selected;
    if (!context || !prompt || sending || activeRun()) return;
    if (!selected) {
      loadError = store.get().models.length === 0 ? "Connect a provider account in Settings to use side chats." : "Choose a model for side chats.";
      render(); return;
    }
    sending = true; loadError = undefined; renderComposer();
    const current = context;
    try {
      const firstTurn = runs.length === 0;
      const id = await ensureSession();
      const hidden = await current.context(firstTurn);
      const reasoningEffort = model.reasoningEffort, speed = model.speed;
      const ok = await controller.startRun({
        sessionId: id, runtimeId: selected.runtimeId, providerId: selected.providerId,
        ...(selected.id === "default" ? {} : { model: selected.id }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(speed === undefined ? {} : { speed }),
        prompt: sideChatPrompt(prompt, hidden),
        permissionMode: "read_only", interactionMode: "normal",
      });
      if (ok && context === current) { if (input.value.trim() === prompt) input.value = ""; await load(); }
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally { sending = false; render(); }
  }

  async function submitInput(): Promise<void> {
    const running = activeRun();
    if (running) { await controller.cancelRun(running.run.id); return; }
    await send(input.value);
  }

  function renderComposer(): void {
    const state = store.get();
    model.update(state.models, state.favoriteModelKeys);
    const running = activeRun();
    submit.replaceChildren(icon(running ? "stop" : "arrow-up"));
    submit.title = running ? "Stop" : "Send"; submit.setAttribute("aria-label", submit.title);
    submit.disabled = !context || (running === undefined && (sending || !input.value.trim() || model.selected === undefined));
    input.disabled = !context;
    clear.disabled = !context || running !== undefined || sessionId === undefined;
    hint.textContent = loadError ?? (state.models.length === 0 ? "Connect a provider account to use side chats." : model.selected === undefined ? "Choose a model to start." : "");
    hint.classList.toggle("error-line", loadError !== undefined);
  }

  function render(): void {
    title.textContent = context?.title ?? "Side chat";
    subtitle.textContent = context?.subtitle ?? "";
    subtitle.hidden = !context?.subtitle;
    const state = store.get();
    const live = Object.values(state.live).map((entry) => entry.run).filter((run) => run.sessionId === sessionId && sessionId !== undefined && !runs.some((stored) => stored.id === run.id));
    const all = [...runs, ...live];
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    if (!context) replace(transcript, h("div", { class: "side-chat-empty" }, icon("chat-circle-text"), h("p", {}, "Open a session or pull request to start a side chat.")));
    else if (all.length === 0) {
      replace(transcript, h("div", { class: "side-chat-empty" }, icon("chat-circle-text"), h("p", {}, context.emptyHint),
        ...(context.suggestions ?? []).map((suggestion) => h("button", { class: "button button-small pr-action side-chat-suggestion", type: "button", disabled: model.selected === undefined || sending, title: model.selected === undefined ? "Choose a model first" : suggestion.prompt, onClick: () => void send(suggestion.prompt) },
          icon(suggestion.icon), h("span", {}, suggestion.label)))));
    } else replace(transcript, ...all.map((run) => renderTurn(run)));
    if (atBottom || all.length === 0) transcript.scrollTop = transcript.scrollHeight;
    renderComposer();
  }

  function renderTurn(run: RunView): HTMLElement {
    const live = store.get().live[run.id];
    const current = live?.run ?? run;
    const reply: Node[] = [];
    const actions = { openLink: (href: string) => controller.openExternal(href), openPath: (path: string) => void controller.openPath(path) };
    if (live) {
      const folded = foldEvents(live.events);
      const text = folded.items.flatMap((item) => item.kind === "text" ? [item.text] : []).join("\n\n");
      const tools = folded.items.filter((item) => item.kind === "tool").length;
      if (text) reply.push(h("div", { class: "md" }, renderMarkdown(text, actions)));
      if (isActiveStatus(current.status)) reply.push(h("div", { class: "note side-chat-working" }, icon("circle-notch", { className: "spin" }),
        live.cancelRequested ? "Stopping" : tools ? `Reading (${tools} ${tools === 1 ? "step" : "steps"})` : "Thinking"));
      if (folded.failure) reply.push(h("div", { class: "error-line" }, icon("warning-circle"), h("span", {}, folded.failure.error)));
    } else {
      const answer = messages.find((message) => message.role === "assistant" && message.metadata?.["runId"] === run.id)?.content ?? run.result;
      if (answer) reply.push(h("div", { class: "md" }, renderMarkdown(answer, actions)));
      if (run.error) reply.push(h("div", { class: "error-line" }, icon("warning-circle"), h("span", {}, run.error)));
      else if (!answer && run.status === "interrupted") reply.push(h("div", { class: "note" }, icon("stop-circle"), "Stopped"));
    }
    return h("article", { class: "side-chat-turn" },
      h("div", { class: "side-chat-question" }, h("div", { class: "bubble" }, h("div", { class: "bubble-text" }, visiblePrompt(run.prompt)))),
      h("div", { class: "side-chat-answer" }, ...reply, h("time", { class: "note side-chat-time", title: run.createdAt }, relativeTime(run.createdAt))));
  }

  // Stream updates for this chat's runs; reload once a run leaves `live`.
  store.watch((state) => [state.live, state.models, state.favoriteModelKeys], (_slice, state) => {
    const mine = new Set(Object.values(state.live).filter((entry) => entry.run.sessionId === sessionId).map((entry) => entry.run.id));
    const finished = [...seenLive].some((id) => !mine.has(id));
    seenLive = mine;
    if (finished) void load(); else render();
  });

  return {
    element,
    setContext(next) {
      if (next?.key === context?.key) { context = next; render(); return; }
      context = next; generation++;
      sessionId = next ? loadSessions()[next.key] : undefined;
      runs = []; messages = []; loadError = undefined; input.value = "";
      render(); void load();
    },
    send,
    focus() { input.focus(); },
  };
}

/**
 * Lets a docked side chat be resized from its left edge. The width is a CSS
 * variable on the dock container (`--side-chat-width`), clamped so the review
 * keeps MIN_REVIEW_WIDTH, and saved per device. Double-click resets it.
 */
function attachDockResize(panel: HTMLElement): void {
  let width = DOCK_DEFAULT;
  try { const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY)); if (Number.isFinite(saved) && saved >= DOCK_MIN) width = saved; } catch { /* Use the default width. */ }
  const max = () => Math.max(DOCK_MIN, (panel.parentElement?.clientWidth ?? 0) - MIN_REVIEW_WIDTH);
  const apply = (next: number) => { width = next; panel.parentElement?.style.setProperty("--side-chat-width", `${Math.min(next, max())}px`); };
  panel.append(createResizeHandle({
    label: "Resize side chat", edge: "left", min: DOCK_MIN, max, defaultWidth: DOCK_DEFAULT,
    width: () => panel.getBoundingClientRect().width,
    onResize: apply,
    onCommit: (next) => { try { localStorage.setItem(DOCK_WIDTH_KEY, String(next)); } catch { /* Keep it for this window. */ } },
  }));
  // Apply once the panel is attached to its dock, and re-clamp when the window changes.
  new ResizeObserver(() => apply(width)).observe(panel);
}
