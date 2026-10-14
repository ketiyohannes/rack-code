/**
 * Center column: the open session as a simple chat transcript.
 *
 * Each run is one turn:
 * - the prompt is a right-aligned bubble with no technical message metadata;
 * - the reply is plain text in the page (no bubble), rendered as Markdown.
 *   While a run is active it shows the live event fold: streaming text,
 *   compact one-line tool rows that expand on click, and approval cards.
 *   A finished run shows its persisted assistant message;
 * - a quiet meta row under the reply has copy, time, the runtime/account
 *   labels, a Details toggle (inline run details and journal), and Stop
 *   while active.
 *
 * Also renders the session title in the toolbar slot, a left-edge turn
 * navigator (one tick per turn, highlighting those in view), and a
 * "Scroll to end" pill when the view is not at the bottom.
 *
 * The transcript re-renders on every state change (batched per frame), so
 * presentation state that must survive a re-render (opened tool rows) lives
 * in a closure set keyed by stable IDs.
 */
import type {
  RunView,
  SessionView,
  WorkspaceView,
} from "../../../contracts/desktop/index.js";
import type { Controller } from "../controller.js";
import { formatData, formatTime, h, replace, shortId } from "../dom.js";
import { icon } from "../icons.js";
import { renderMarkdown } from "../markdown.js";
import type { AppState, LiveRun, Store } from "../store.js";
import { foldEvents, type TranscriptItem, type TranscriptState } from "../transcript.js";
import { renderRunDetails } from "./run-detail.js";
import { accountLabel, isActiveStatus, PERMISSION_LABELS, runtimeOf } from "./run-format.js";

/** Distance from the bottom, in pixels, that still counts as "at the end". */
const AT_END_THRESHOLD = 48;

interface ViewMemory {
  readonly openTools: Set<string>;
}

export function mountSessionView(root: HTMLElement, header: HTMLElement, store: Store, controller: Controller): void {
  const transcript = h("div", { class: "transcript" });
  const rail = h("nav", { class: "turn-rail", aria: { label: "Turns" } });
  const scrollToEnd = h("button", {
    class: "scroll-end",
    onClick: () => transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" }),
  }, icon("caret-down"), "Scroll to end");
  scrollToEnd.hidden = true;
  root.append(transcript, rail, scrollToEnd);

  const memory: ViewMemory = { openTools: new Set() };
  let current: AppState | undefined;
  // Folding is memoized per events array: unchanged live runs are not re-folded.
  const folds = new WeakMap<readonly unknown[], TranscriptState>();
  const fold = (live: LiveRun): TranscriptState => {
    let state = folds.get(live.events);
    if (state === undefined) {
      state = foldEvents(live.events);
      folds.set(live.events, state);
    }
    return state;
  };

  const isAtEnd = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < AT_END_THRESHOLD;
  const updateChrome = () => {
    scrollToEnd.hidden = isAtEnd();
    updateRail(rail, transcript);
  };
  transcript.addEventListener("scroll", updateChrome, { passive: true });

  function draw(state: AppState, jumpToEnd: boolean): void {
    // Keep following streamed output only when the user is already at the end.
    const follow = jumpToEnd || isAtEnd();
    const scrollTop = transcript.scrollTop;
      replace(transcript, ...renderTranscript(state, controller, fold, memory));
    transcript.scrollTop = follow ? transcript.scrollHeight : scrollTop;
    renderRail(rail, transcript);
    updateChrome();
  }

  store.watch((state) => [state.session, state.workspaces, state.selection.sessionId], (_slice, state) => {
    replace(header, ...renderHeader(state.session, state.workspaces));
  });

  let lastSessionId: string | undefined;
  store.watch(
    (state) => [state.session, state.runs, state.live, state.accounts, state.selection.runId, state.journal, state.workspaces, state.runtimes, state.acknowledgedUnknown],
    (_slice, state) => {
      current = state;
      const sessionChanged = state.session?.id !== lastSessionId;
      lastSessionId = state.session?.id;
      draw(state, sessionChanged);
    },
  );
}

function renderHeader(session: SessionView | undefined, workspaces: readonly WorkspaceView[]): Node[] {
  if (session === undefined) {
    return [h("span", { class: "session-title muted" }, "No session")];
  }
  const workspace = workspaces.find((candidate) => candidate.id === session.workspaceId);
  const meta = [
    workspace?.path ?? shortId(session.workspaceId),
    workspace?.kind,
    workspace?.startingRevision?.slice(0, 7),
  ].filter((part) => part !== undefined).join(" / ");
  return [
    h("span", { class: "session-title" }, session.title ?? `Session ${shortId(session.id)}`),
    h("span", { class: "session-meta", title: meta }, meta),
    h("div", { class: "session-chips" },
      workspace?.activeWriterAttemptId === undefined ? null : h("span", { class: "chip" },
        icon("pencil-simple"), `writer ${shortId(workspace.activeWriterAttemptId)}`),
    ),
  ];
}

function renderTranscript(
  state: AppState,
  controller: Controller,
  fold: (live: LiveRun) => TranscriptState,
  memory: ViewMemory,
): Node[] {
  const session = state.session;
  if (session === undefined || state.selection.sessionId === undefined) {
    return [placeholder("chat-circle-text", "No session selected", "Open a session from the sidebar, or start one with the + on a project folder.")];
  }

  // Live runs of this session that the persisted list does not contain yet.
  const liveOnly = Object.values(state.live)
    .map((live) => live.run)
    .filter((run) => run.sessionId === session.id && !state.runs.some((stored) => stored.id === run.id));
  const runs = [...state.runs, ...liveOnly];
  if (runs.length === 0) {
    return [placeholder("terminal-window", "What should we work on?", "Describe a task below. The agent works in this session's workspace.")];
  }
  return runs.map((run) => renderTurn(run, state, controller, fold, memory));
}

function renderTurn(
  stored: RunView,
  state: AppState,
  controller: Controller,
  fold: (live: LiveRun) => TranscriptState,
  memory: ViewMemory,
): HTMLElement {
  const live = state.live[stored.id];
  const run = live?.run ?? stored;
  const account = state.accounts.find((candidate) => candidate.id === run.accountId);
  const detailsOpen = state.selection.runId === run.id;
  const openLink = (href: string) => controller.openExternal(href);

  const reply: Node[] = [];
  let copyText = "";
  if (live !== undefined) {
    const folded = fold(live);
    for (const [index, item] of folded.items.entries()) {
      const rendered = renderItem(item, `${run.id}:${index}`, memory, openLink);
      if (rendered !== undefined) reply.push(rendered);
    }
    copyText = folded.items.flatMap((item) => item.kind === "text" ? [item.text] : []).join("\n\n");
    if (folded.failure !== undefined) reply.push(errorLine(folded.failure.error));
    if (isActiveStatus(run.status)) {
      reply.push(h("div", { class: "working" },
        icon("circle-notch", { className: "spin" }),
        live.cancelRequested ? "Stopping" : run.status === "queued" ? "Waiting for the workspace" : "Working"));
    }
  } else {
    const assistant = state.session?.messages.find((message) =>
      message.role === "assistant" && message.metadata?.["runId"] === run.id);
    copyText = assistant?.content ?? run.result ?? "";
    if (copyText !== "") reply.push(h("div", { class: "md" }, renderMarkdown(copyText, openLink)));
    if (run.error !== undefined) reply.push(errorLine(run.error));
    if (run.status === "interrupted") reply.push(h("div", { class: "note" }, icon("stop-circle"), "Stopped"));
    if (run.status === "unknown") reply.push(h("div", { class: "note" }, icon("question"), "Ended without a final result. Open Details before continuing."));
  }
  if (live?.fallbackFromAccountId !== undefined) {
    const from = state.accounts.find((candidate) => candidate.id === live.fallbackFromAccountId);
    reply.unshift(h("div", { class: "note" }, icon("info"),
      `${accountLabel(from, live.fallbackFromAccountId)} was unavailable; using ${accountLabel(account, run.accountId)}.`));
  }

  const labels = [runtimeOf(run), accountLabel(account, run.accountId), run.model, PERMISSION_LABELS[run.permissionMode].label]
    .filter((part): part is string => part !== undefined).join(" · ");
  const meta = h("div", { class: "turn-meta" },
    copyText === "" ? null : h("button", {
      class: "icon-button meta-button",
      title: "Copy reply",
      aria: { label: "Copy reply" },
      onClick: (event) => void copy(copyText, event.currentTarget as HTMLButtonElement),
    }, icon("copy")),
    h("span", { class: "meta-time" }, formatTime(run.createdAt)),
    h("span", { class: "meta-labels" }, labels),
    h("button", {
      class: detailsOpen ? "meta-link active" : "meta-link",
      aria: { expanded: String(detailsOpen) },
      onClick: () => void controller.selectRun(run.id),
    }, "Details"),
    live !== undefined && isActiveStatus(run.status)
      ? h("button", {
        class: "meta-link",
        disabled: live.cancelRequested,
        onClick: () => void controller.cancelRun(run.id),
      }, live.cancelRequested ? "Stopping" : "Stop")
      : null,
  );

  return h("article", { class: "turn", data: { runId: run.id } },
    renderPrompt(run),
    h("div", { class: "reply" }, ...reply, meta, detailsOpen ? renderRunDetails(run, state, controller) : null),
  );
}

function renderPrompt(run: RunView): HTMLElement {
  return h("div", { class: "prompt-row" },
    h("div", { class: "bubble" },
      h("div", { class: "bubble-text" }, run.prompt),
    ),
  );
}

function renderItem(
  item: TranscriptItem,
  key: string,
  memory: ViewMemory,
  openLink: (href: string) => void,
): Node | undefined {
  switch (item.kind) {
    case "text":
      return h("div", { class: "md" }, renderMarkdown(item.text, openLink));
    case "tool":
      return toolLine(key, memory, item.hasOutput ? "check" : "circle-notch", item.tool, item.hasOutput ? "" : "running",
        [["Input", item.input], ...(item.hasOutput ? [["Output", item.output] as const] : [])], !item.hasOutput);
    case "tool_output":
      return toolLine(key, memory, "terminal-window", "Tool result", "", [["Output", item.output]], false);
    case "thinking":
      return thinkingLine(key, memory, item.text);
    case "approval":
      // Pending approvals are rendered above the composer. Keeping them out
      // of the transcript avoids mixing an authorization prompt with the
      // assistant's trace.
      return undefined;
    case "status":
      return h("div", { class: "note" }, icon("info"), item.label, item.detail === undefined ? null : `: ${item.detail}`);
  }
}

/** One-line tool row; expands to show input/output. Open state survives re-renders. */
function toolLine(
  key: string,
  memory: ViewMemory,
  iconName: Parameters<typeof icon>[0],
  title: string,
  status: string,
  sections: ReadonlyArray<readonly [string, unknown]>,
  spinning: boolean,
): HTMLElement {
  const details = h("details", { class: "tool-line", open: memory.openTools.has(key) },
    h("summary", {},
      icon(iconName, { className: spinning ? "spin" : "" }),
      h("span", { class: "tool-line-title" }, title),
      status === "" ? null : h("span", { class: "tool-line-status" }, status),
      icon("caret-right", { className: "tool-line-caret" }),
    ),
    ...sections.map(([name, value]) => h("div", { class: "tool-line-section" },
      h("span", { class: "label" }, name),
      h("pre", {}, formatData(value)),
    )),
  );
  details.addEventListener("toggle", () => {
    if (details.open) memory.openTools.add(key);
    else memory.openTools.delete(key);
  });
  return details;
}

/** Collapsed reasoning trace; unlike user prompts this is useful diagnostic output. */
function thinkingLine(key: string, memory: ViewMemory, text: string): HTMLElement {
  const details = h("details", { class: "thinking-line", open: memory.openTools.has(key) },
    h("summary", {},
      icon("brain"),
      h("span", { class: "tool-line-title" }, "Thinking"),
      icon("caret-right", { className: "tool-line-caret" }),
    ),
    h("div", { class: "thinking-text" }, text),
  );
  details.addEventListener("toggle", () => {
    if (details.open) memory.openTools.add(key);
    else memory.openTools.delete(key);
  });
  return details;
}

function errorLine(text: string): HTMLElement {
  return h("div", { class: "error-line" }, icon("warning-circle"), h("span", {}, text));
}

function placeholder(iconName: Parameters<typeof icon>[0], title: string, text: string): HTMLElement {
  return h("div", { class: "placeholder" },
    h("span", { class: "placeholder-icon" }, icon(iconName)),
    h("p", { class: "placeholder-title" }, title),
    h("p", { class: "placeholder-text" }, text),
  );
}

/** Copies text and briefly swaps the button icon to a check mark. */
async function copy(text: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    replace(button, icon("check"));
    window.setTimeout(() => replace(button, icon("copy")), 1200);
  } catch {
    // Clipboard access can be refused; copying is a convenience.
  }
}

/** One tick per turn; clicking a tick scrolls that turn into view. */
function renderRail(rail: HTMLElement, transcript: HTMLElement): void {
  const turns = [...transcript.querySelectorAll<HTMLElement>(".turn")];
  rail.hidden = turns.length < 2;
  replace(rail, ...turns.map((turn, index) => h("button", {
    class: "turn-tick",
    title: `Turn ${index + 1}`,
    aria: { label: `Go to turn ${index + 1}` },
    onClick: () => turn.scrollIntoView({ behavior: "smooth", block: "start" }),
  })));
}

/** Highlights the ticks of turns currently visible in the transcript. */
function updateRail(rail: HTMLElement, transcript: HTMLElement): void {
  const view = transcript.getBoundingClientRect();
  const turns = transcript.querySelectorAll<HTMLElement>(".turn");
  const ticks = rail.querySelectorAll<HTMLElement>(".turn-tick");
  turns.forEach((turn, index) => {
    const rect = turn.getBoundingClientRect();
    ticks[index]?.classList.toggle("visible", rect.bottom > view.top && rect.top < view.bottom);
  });
}
