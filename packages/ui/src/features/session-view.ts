import { isWorkflowActive, type WorkflowRun } from "@rack/features/orchestration/types";
import { sessionWorkerRunIds } from "./orchestra-state.js";
import { createOpenInButton } from "../components/open-in.js";
import { openModal } from "../components/modal.js";
import { bindContentMenu } from "../components/context-menu.js";
import { selectionQuestion } from "./side-chat-prompt.js";
/**
 * Center column: the open session as a simple chat transcript.
 *
 * Each run is one turn:
 * - the prompt is a right-aligned bubble; long prompts are clipped with a
 *   "Show full message" toggle;
 * - the reply is plain text in the page (no bubble), rendered as Markdown.
 *   Live and persisted event folds (`turn-activity.ts`) show streamed text,
 *   readable thinking panels, and each run of consecutive tool calls as one
 *   tool group card (`tool-group-card.ts`) with per-call rows, timing and
 *   expandable details. Completed turns keep their activity after reload;
 *   the saved assistant message is a fallback;
 * - a pending approval for one of this session's calls is answered on that
 *   call's row inside its tool group; the composer only points to it;
 * - the latest finished turn offers "Run again";
 * - the quiet footer shows only the date and time; active runs are stopped
 *   from the composer.
 *
 * Also renders the session title in the toolbar slot, a left-edge turn
 * navigator (one tick per turn, highlighting those in view), and a
 * "Scroll to end" pill when the view is not at the bottom.
 *
 * Completed turns retain their DOM while the active turn changes. History
 * starts with the newest page; disclosure state survives paging by stable ID.
 */
import type {
  RunView,
  SessionView,
  ProjectView,
  RuntimeEvent,
  SessionMessageView,
  SessionWorkspaceView,
} from "@rack/contracts";
import type { Controller } from "../controller.js";
import { formatTime, h, replace, shortId } from "../dom.js";
import { icon } from "../icons.js";
import { renderMarkdown, type MarkdownActions } from "../markdown.js";
import type { AppState, Store } from "../store.js";
import { type TranscriptItem } from "../transcript.js";
import { reconcileChildren, TurnActivityCache } from "../render-cache.js";
import { ToolGroupCard, type RetryRequest } from "./tool-group-card.js";
import type { TurnActivity } from "./turn-activity.js";
import { accountLabel, isActiveStatus } from "./run-format.js";
import { importedTool, presentTool } from "./tool-presentation.js";
import { collectRunChanges, type RunFileChange } from "./run-changes.js";
import { renderFileDiff, renderFileRow } from "./changes-view.js";
import { formatAttachmentSize } from "./attachments.js";
import { compacts, type ActivityItem } from "./tool-groups.js";
import { renderWorkspaceChip } from "./workspace.js";
import { visibleRuns as conversationRuns, visibleWorkflowRuns, supersededRunIds, canEditTurn, turnsReplacedByEdit } from "./conversation-history.js";
import { createMessageEditor, type MessageEditor } from "./message-editor.js";
import { activeWorkflow } from "./orchestra-state.js";

/** Prompts longer than this (characters or lines) start clipped. */
const LONG_PROMPT_CHARS = 600;
const LONG_PROMPT_LINES = 8;
/** Distance from the bottom, in pixels, that still counts as "at the end". */
const AT_END_THRESHOLD = 48;

interface ViewMemory {
  readonly expandedPrompts: Set<string>;
  readonly openTools: Set<string>;
  readonly openToolGroups: Set<string>;
  /** Selected file in each reply's "files changed" card, by run ID. */
  readonly selectedChanges: Map<string, string>;
  /** Inline/split diff choice shared by every reply's changes card. */
  readonly splitChanges: { value: boolean };
  /** Tool group cards by `<runId>:<groupId>`, kept so redraws patch rather than rebuild them. */
  readonly cards: Map<string, ToolGroupCard>;
  /**
   * Each turn's article and reply container, by run ID. Kept across redraws
   * so a streaming reply is patched in place and its tool group cards are
   * never detached (detaching restarts their animations).
   */
  readonly turnNodes: Map<string, { readonly article: HTMLElement; readonly reply: HTMLElement }>;
  /** Each workflow worker's activity wrapper, by worker ID, kept for the same reason. */
  readonly workerNodes: Map<string, HTMLElement>;
  /** Worker runs whose journals were already requested, so a redraw does not re-request them. */
  readonly requestedActivity: Set<string>;
  /** The open inline editor for an earlier message, kept across redraws so its draft and focus survive. */
  readonly editor: { current: MessageEditor | undefined };
}

/** How a turn's message offers editing. Absent when the turn cannot be edited at all. */
interface PromptEdit {
  /** Why Edit is unavailable right now (a turn running): its tooltip and accessible description. */
  readonly blocked: string | undefined;
  readonly open: () => void;
}

export function mountSessionView(root: HTMLElement, header: HTMLElement, store: Store, controller: Controller): void {
  const transcript = h("div", { class: "transcript" });
  const rail = h("nav", { class: "turn-rail", aria: { label: "Turns" } });
  const scrollToEnd = h("button", {
    class: "scroll-end", title: "Scroll to end", aria: { label: "Scroll to end" },
    onClick: () => transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" }),
  }, icon("caret-down"));
  scrollToEnd.hidden = true;
  root.append(transcript, rail, scrollToEnd);
  const closeContentMenu = bindContentMenu(transcript, ({ selection }) => {
    const sessionId = store.get().selection.sessionId;
    if (!sessionId || store.get().session?.id !== sessionId) return [];
    const open = (draft?: string) => {
      if (store.get().selection.sessionId === sessionId) controller.openTool("side-chat", draft);
    };
    return [
      { label: "Open side chat", icon: "chat-circle-text", run: () => open() },
      ...(selection ? [{ label: "Ask about selection", icon: "sparkle" as const, run: () => open(selectionQuestion(selection)) }] : []),
    ];
  });

  const memory: ViewMemory = { expandedPrompts: new Set(), openTools: new Set(), openToolGroups: new Set(), selectedChanges: new Map(), splitChanges: { value: false },
    cards: new Map(), turnNodes: new Map(), workerNodes: new Map(), requestedActivity: new Set(), editor: { current: undefined } };
  let current: AppState | undefined;
  const folds = new TurnActivityCache();
  const turns = new Map<string, { signature: readonly unknown[]; node: HTMLElement }>();
  let importedCache: { messages: readonly SessionMessageView[]; nodes: Node[] } | undefined;
  let visibleRuns = 50;
  let visibleMessages = 100;
  const rerender = () => {
    turns.clear(); importedCache = undefined;
    if (current !== undefined) draw(current, false);
  };
  const fold = (id: string, events: readonly RuntimeEvent[]) => folds.fold(id, events);
  const openEditor = (run: RunView) => {
    memory.editor.current = createMessageEditor({
      runId: run.id, prompt: run.prompt, attachmentCount: run.attachments?.length ?? 0,
      save: async (text) => {
        const accepted = await controller.editMessage(run, text);
        if (accepted) {
          memory.editor.current = undefined;
          rerender();
          // The edited turn is gone; continue where the new turn is composed.
          root.ownerDocument.querySelector<HTMLElement>(".prompt-input")?.focus({ preventScroll: true });
        }
        return accepted;
      },
      cancel: () => {
        memory.editor.current = undefined;
        rerender();
        transcript.querySelector<HTMLElement>(`.turn[data-run-id="${CSS.escape(run.id)}"] .prompt-edit`)?.focus();
      },
    });
    rerender();
    memory.editor.current.focus();
  };
  const renderCachedTurn = (run: RunView, state: AppState): HTMLElement => {
    const live = state.live[run.id];
    const latest = latestRunId(state) === run.id;
    const busy = sessionBusy(state);
    const blocked = editBlockedReason(state);
    const editable = live === undefined && canEditTurn(state, run);
    const editing = memory.editor.current?.runId === run.id;
    const signature = [run, live, state.transcripts[run.id], state.accounts, state.session?.messages, latest, busy, editable, blocked];
    const cached = turns.get(run.id);
    // A turn with an open editor always redraws: how many turns a save
    // replaces depends on the rest of the conversation.
    if (!editing && cached && signature.every((value, index) => value === cached.signature[index])) return cached.node;
    const node = renderTurn(run, state, controller, fold, memory, rerender, { latest, busy },
      editable ? { blocked, open: () => openEditor(run) } : undefined);
    turns.set(run.id, { signature, node });
    return node;
  };
  const workflowTurns = new Map<string, { signature: readonly unknown[]; node: HTMLElement }>();
  const requestActivity = (runIds: readonly string[]) => {
    const fresh = runIds.filter((id) => !memory.requestedActivity.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) memory.requestedActivity.add(id);
    void controller.loadSessionActivity(fresh);
  };
  /** Workflow turns redraw only when the run record, a worker's events or the saved answer changed. */
  const renderCachedWorkflow = (run: WorkflowRun, state: AppState): HTMLElement => {
    const signature = [run, state.session?.messages, ...run.workers.flatMap((worker) => worker.runId === undefined ? []
      : [state.live[worker.runId], state.transcripts[worker.runId]])];
    const cached = workflowTurns.get(run.id);
    if (cached && signature.length === cached.signature.length && signature.every((value, index) => value === cached.signature[index])) return cached.node;
    const node = renderWorkflowTurn(run, state, controller, fold, memory, rerender, requestActivity);
    workflowTurns.set(run.id, { signature, node });
    return node;
  };
  const renderCachedHistory = (messages: readonly SessionMessageView[], state: AppState): Node[] => {
    const source = state.session!.messages;
    if (importedCache?.messages === source) return importedCache.nodes;
    const nodes = renderImportedHistory(messages.slice(-visibleMessages), memory, rerender, markdownActions(controller));
    importedCache = { messages: source, nodes };
    return nodes;
  };
  const older = h("button", { class: "icon-button", type: "button", title: "Load earlier messages", aria: { label: "Load earlier messages" }, onClick: () => {
    visibleRuns += 50; visibleMessages += 100; importedCache = undefined;
    if (current !== undefined) {
      void controller.loadSessionActivity(current.runs.slice(-visibleRuns).map((run) => run.id));
      draw(current, false);
    }
  } }, icon("clock-counter-clockwise"));

  const isAtEnd = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < AT_END_THRESHOLD;
  const updateChrome = () => {
    scrollToEnd.hidden = isAtEnd();
    updateRail(rail, transcript);
  };
  transcript.addEventListener("scroll", updateChrome, { passive: true });

  // Notices and queued messages float above the composer, over the end of
  // the transcript. Reserve their height as bottom padding so the newest
  // output never hides under them, and keep following the end if the view
  // was there. The composer mounts after this view, hence the frame delay.
  requestAnimationFrame(() => {
    const overlays = root.ownerDocument.querySelector(".composer-overlays");
    if (overlays === null || typeof ResizeObserver === "undefined") return;
    new ResizeObserver(() => {
      const height = Math.ceil(overlays.getBoundingClientRect().height);
      const space = height === 0 ? "0px" : `${height + 8}px`;
      if (transcript.style.getPropertyValue("--composer-overlay-space") === space) return;
      const follow = isAtEnd();
      transcript.style.setProperty("--composer-overlay-space", space);
      if (follow) transcript.scrollTop = transcript.scrollHeight;
      updateChrome();
    }).observe(overlays);
  });

  function draw(state: AppState, jumpToEnd: boolean): void {
    // Keep following streamed output only when the user is already at the end.
    const follow = jumpToEnd || isAtEnd();
    const scrollTop = transcript.scrollTop;
    const children = renderTranscript(state, controller, fold, memory, rerender,
      (run) => renderCachedTurn(run, state), (messages) => renderCachedHistory(messages, state), visibleRuns,
      (run) => renderCachedWorkflow(run, state));
    const hasEarlier = conversationRuns(state).length > visibleRuns || (state.session?.messages.filter((message) => message.metadata?.["imported"] === "true").length ?? 0) > visibleMessages;
    reconcileChildren(transcript, hasEarlier ? [older, ...children] : children);
    // The edited turn left the conversation (replaced in another window, or
    // the session changed); its editor goes with it.
    if (memory.editor.current !== undefined && !transcript.contains(memory.editor.current.element)) memory.editor.current = undefined;
    transcript.scrollTop = follow ? transcript.scrollHeight : scrollTop;
    const ids = [...transcript.querySelectorAll<HTMLElement>(".turn")].map((turn) => turn.dataset["runId"] ?? turn.id).join("|");
    if (rail.dataset["turns"] !== ids) { renderRail(rail, transcript); rail.dataset["turns"] = ids; }
    updateChrome();
  }

  store.watch((state) => [state.session, state.projects, state.selection.sessionId, state.selection.projectId, state.workspace], (_slice, state) => {
    replace(header, ...renderHeader(state.session, state.projects, controller, state.selection.projectId, state.workspace));
  });

  let lastSessionId: string | undefined;
  store.watch(
    (state) => [state.orchestra,state.page, state.session, state.selection.sessionId, state.selection.projectId, state.runs, state.transcripts, state.accounts, state.projects, ...((workers) => Object.values(state.live).filter((live) => live.run.sessionId === state.selection.sessionId || workers.has(live.run.id)))(sessionWorkerRunIds(state))],
    (_slice, state) => {
      current = state;
      const sessionChanged = state.session?.id !== lastSessionId;
      if (sessionChanged || state.page !== "chat") closeContentMenu();
      lastSessionId = state.session?.id;
      if (sessionChanged) { turns.clear(); workflowTurns.clear(); folds.clear(); memory.cards.clear(); memory.turnNodes.clear(); memory.workerNodes.clear(); memory.requestedActivity.clear(); memory.editor.current = undefined; importedCache = undefined; visibleRuns = 50; visibleMessages = 100; }
      if (state.page === "chat" && !document.hidden) draw(state, sessionChanged);
    },
  );
  document.addEventListener("visibilitychange", () => { if (!document.hidden && current?.page === "chat") draw(current, false); });
}

function renderHeader(session: SessionView | undefined, projects: readonly ProjectView[], controller: Controller, projectId?: string, workspace?: SessionWorkspaceView): Node[] {
  if (session === undefined) {
    const project = projects.find((entry) => entry.id === projectId);
    return [h("span", { class: "session-title muted" }, project?.path.split(/[\\/]/).at(-1) ?? "Workspace"),
      ...(project ? [createOpenInButton(controller, () => controller.resolveEditorTarget(".", project.path))] : [])];
  }
  const project = projects.find((candidate) => candidate.id === session.projectId);
  const meta = [
    project?.path ?? (session.projectId === undefined ? "Chat" : shortId(session.projectId)),
    project?.startingRevision?.slice(0, 7),
  ].filter((part) => part !== undefined).join(" / ");
  return [
    h("span", { class: "session-title" }, session.title ?? (session.projectId === undefined ? "New chat" : `Session ${shortId(session.id)}`)),
    h("span", { class: "session-meta", title: meta }, meta),
    h("div", { class: "session-chips" },
      h("button", { class: "icon-button", type: "button", title: "Side chat: ask without interrupting this session", aria: { label: "Open side chat" }, onClick: () => controller.openTool("side-chat") }, icon("chat-circle-text")),
      createOpenInButton(controller, () => controller.resolveEditorTarget(".", undefined, session.id)),
      session.projectId === undefined ? h("button", { class: "button button-small", type: "button", onClick: () => {
        const content = h("div", { class: "modal-body attach-project-list" },
          h("p", { class: "note" }, "Keep this conversation and continue in a project. Chat files remain in their original workspace."),
          ...projects.map((project) => h("button", { class: "button", type: "button", onClick: async () => { if (await controller.attachProject(session.id, project.id)) modal.close(); } }, project.path)),
          h("button", { class: "button button-primary", type: "button", onClick: async () => { if (await controller.attachProject(session.id)) modal.close(); } }, "Choose folder…"));
        const modal = openModal({ title: "Attach a project", content });
      } }, icon("folder-simple-plus"), "Attach project") : null,
      (session.originatedAsChat || session.projectId === undefined) ? h("button", { class: "icon-button", type: "button", title: "Open chat files", aria: { label: "Open chat files" }, onClick: () => void controller.openSessionPath(session.id, "", true) }, icon("folder-open")) : null,
      // Where this session runs: its isolated worktree, or a warning while
      // other shared sessions edit the same folder.
      renderWorkspaceChip(session, workspace?.mode === (session.workspaceMode ?? "shared") ? workspace : undefined, project, controller),
    ),
  ];
}

function renderTranscript(
  state: AppState,
  controller: Controller,
  fold: (id: string, events: readonly RuntimeEvent[]) => TurnActivity,
  memory: ViewMemory,
  rerender: () => void,
  renderRun: (run: RunView) => HTMLElement,
  renderHistory: (messages: readonly SessionMessageView[]) => Node[],
  visibleRuns: number,
  renderWorkflow: (run: WorkflowRun) => HTMLElement,
): Node[] {
  const session = state.session;
  if (session === undefined || state.selection.sessionId === undefined) {
    const project = state.projects.find((entry) => entry.id === state.selection.projectId);
    const start = async () => {
      if (project) { await controller.createSessionForProject(project.id); return; }
      const path = await controller.selectDirectory("Choose project folder");
      if (path) await controller.createProject({ path });
    };
    return [h("div", { class: "placeholder welcome" },
      h("span", { class: "welcome-eyebrow" }, "RACK"),
      h("span", { class: "welcome-mark", aria: { hidden: "true" } }, icon("stack")),
      h("h1", { class: "welcome-title" }, project ? "Ready when you are." : "A little space. A big idea."),
      h("p", { class: "placeholder-text" }, project
        ? `Start a session in ${project.path.split(/[\\/]/).at(-1)} and turn your next idea into working code.`
        : "Open a project, connect your account, and give your next idea room to take shape."),
      h("div", { class: "welcome-actions" },
        h("button", { class: "icon-button welcome-primary", type: "button", title: project ? "Start a session" : "Open a project folder", aria: { label: project ? "Start a session" : "Open a project folder" }, onClick: () => void start() }, icon(project ? "plus" : "folder-simple-plus")),
        h("button", { class: "icon-button", type: "button", title: "Manage provider accounts", aria: { label: "Manage provider accounts" }, onClick: () => controller.openSettings("accounts") }, icon("plugs"))),
      h("p", { class: "welcome-caption" }, project ? "Your files stay right where they are." : "Your projects. Your accounts. Your workspace."))];
  }

  // Live runs of this session that the persisted list does not contain yet.
  // Turns replaced by an edit are left out (see conversation-history.ts).
  const superseded = supersededRunIds(state);
  const liveOnly = Object.values(state.live)
    .map((live) => live.run)
    .filter((run) => run.sessionId === session.id && !superseded.has(run.id) && !state.runs.some((stored) => stored.id === run.id));
  const runs = [...conversationRuns(state), ...liveOnly];
  const workflowRuns = visibleWorkflowRuns(state, session.id);
  const imported = session.messages.filter((message) => message.metadata?.["imported"] === "true");
  if (runs.length === 0 && imported.length === 0 && workflowRuns.length === 0) {
    return [session.projectId === undefined
      ? placeholder("chat-circle-text", "What’s on your mind?", "Ask a question, research a topic, or create something. Attach files whenever you need them.")
      : placeholder("terminal-window", "What should we work on?", "Describe a task below. The agent works in this session's project.")];
  }
  return [
    ...(session.importSource === undefined ? [] : [h("div", { class: "import-history-note note" }, icon("database"),
      `Imported from ${session.importSource.providerName}. Continuing uses recent conversation context in a new runtime session; the original remains unchanged.`)]),
    ...renderHistory(imported),
    ...[...runs.map((run) => ({ createdAt: run.createdAt, render: () => renderRun(run) })), ...workflowRuns.map((run) => ({ createdAt: run.createdAt, render: () => renderWorkflow(run) }))]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-visibleRuns).map((entry) => entry.render()),
  ];
}

/**
 * Imported history uses the same compaction as live turns: consecutive tool
 * and thinking messages form one group, while each message keeps its own
 * identity (and disclosure key) inside it.
 */
function renderImportedHistory(messages: readonly SessionMessageView[], memory: ViewMemory, rerender: () => void, actions: MarkdownActions): Node[] {
  const nodes: Node[] = [];
  let activity: { key: string; item: ActivityItem }[] = [];
  const flush = () => {
    if (activity.length === 0) return;
    if (compacts(activity.map((entry) => entry.item))) {
      nodes.push(h("article", { class: "turn imported-turn", data: { importedMessageId: activity[0]!.key } },
        renderActivityGroup(`import:${activity[0]!.key}`, activity, memory, actions, false, false)));
    } else {
      for (const entry of activity) {
        nodes.push(h("article", { class: "turn imported-turn", data: { importedMessageId: entry.key } },
          renderActivityEntry(entry, memory, actions, false)));
      }
    }
    activity = [];
  };
  for (const message of messages) {
    if (message.metadata?.["presentation"] === "thinking") {
      activity.push({ key: message.id, item: {
        kind: "thinking", text: message.content, format: message.metadata["thinkingFormat"] === "summary" ? "summary" : "trace",
      } });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      activity.push({ key: message.id, item: importedTool(message.content) });
      continue;
    }
    flush();
    nodes.push(h("article", { class: "turn imported-turn", data: { importedMessageId: message.id } },
      message.role === "user" ? renderPrompt({ id: message.id, prompt: message.content }, memory, rerender)
        : h("div", { class: "reply md" }, renderMarkdown(message.content, actions))));
  }
  flush();
  return nodes;
}

/** Run ID of the session's newest turn, live or stored; replaced turns never count. */
function latestRunId(state: AppState): string | undefined {
  const sessionId = state.session?.id;
  const superseded = supersededRunIds(state);
  const runs = [...conversationRuns(state), ...Object.values(state.live).map((live) => live.run).filter((run) => run.sessionId === sessionId && !superseded.has(run.id))];
  return runs.reduce<RunView | undefined>((latest, run) => latest === undefined || run.createdAt > latest.createdAt ? run : latest, undefined)?.id;
}

/** Why an earlier message cannot be edited right now, or undefined when it can. */
function editBlockedReason(state: AppState): string | undefined {
  if (state.host.status !== "ready") return "Rack is not connected to its host right now.";
  if (sessionBusy(state) || activeWorkflow(state) !== undefined) return "Stop the current turn before editing an earlier message.";
  if (state.orchestra.generations?.some((entry) => entry.sessionId === state.session?.id)) return "Finish or cancel the workflow designer before editing a message.";
  return undefined;
}

/** Whether this session has a run the host is still executing. */
function sessionBusy(state: AppState): boolean {
  return Object.values(state.live).some((live) => live.run.sessionId === state.session?.id && isActiveStatus(live.run.status));
}

/** Everything a run's reply needs to render its activity. */
interface ActivityContext {
  readonly runId: string;
  /** The host is executing the run (spinners, Using..., actionable approvals). */
  readonly running: boolean;
  readonly memory: ViewMemory;
  readonly actions: MarkdownActions;
  readonly pendingApprovalIds: ReadonlySet<string>;
  readonly respond: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  readonly canRetry: boolean;
  readonly retry?: (request: RetryRequest) => void;
}

/**
 * A run's activity in reply order: text, thinking and status items, and one
 * tool group card per run of consecutive tool calls. Shared by ordinary turns
 * and by each worker of a workflow turn, so both read identically. Cards are
 * kept in `memory.cards` by run and group so redraws patch them in place.
 */
function renderActivity(activity: TurnActivity, context: ActivityContext): Node[] {
  const { runId, memory, actions } = context;
  const folded = activity.transcript;
  const nodes: Node[] = [];
  for (const segment of activity.segments) {
    if (segment.kind === "item") {
      nodes.push(renderItem(folded.items[segment.index]!, `${runId}:${segment.index}`, memory, actions, context.running));
      continue;
    }
    const group = activity.groups[segment.groupId];
    if (group === undefined) continue;
    const key = `${runId}:${segment.groupId}`;
    let card = memory.cards.get(key);
    if (card === undefined) {
      card = new ToolGroupCard({ respond: context.respond, ...(context.retry === undefined ? {} : { retry: context.retry }) });
      memory.cards.set(key, card);
    }
    card.update({
      runId, group, calls: activity.calls, live: context.running, pendingApprovalIds: context.pendingApprovalIds, canRetry: context.canRetry,
      renderThought: (index) => {
        const item = folded.items[index];
        return item?.kind !== "thinking" ? undefined
          : { signature: `${item.format ?? ""}:${item.text.length}`, render: () => thinkingLine(item.text, item.format, actions) };
      },
    });
    nodes.push(card.element);
  }
  return nodes;
}

function renderTurn(
  stored: RunView,
  state: AppState,
  controller: Controller,
  fold: (id: string, events: readonly RuntimeEvent[]) => TurnActivity,
  memory: ViewMemory,
  rerender: () => void,
  position: { readonly latest: boolean; readonly busy: boolean },
  edit?: PromptEdit,
): HTMLElement {
  const live = state.live[stored.id];
  const run = live?.run ?? stored;
  const account = state.accounts.find((candidate) => candidate.id === run.accountId);
  const actions = markdownActions(controller);
  const running = live !== undefined && isActiveStatus(run.status);

  const reply: Node[] = [];
  let copyText = "";
  const events = live?.events ?? state.transcripts[run.id];
  const activity = events === undefined ? undefined : fold(run.id, events);
  const folded = activity?.transcript;
  if (activity !== undefined && folded !== undefined) {
    reply.push(...renderActivity(activity, {
      runId: run.id, running, memory, actions,
      pendingApprovalIds: new Set(live?.pendingApprovals.map((request) => request.id) ?? []),
      respond: (approvalId, decision) => controller.respondToApproval(run.id, approvalId, decision),
      canRetry: !isActiveStatus(run.status) && position.latest && !position.busy,
      // A provider cannot re-run one tool call on its own, so Retry asks
      // the agent to retry it in a visible follow-up turn.
      retry: ({ action, error }) => void controller.runAgain(run, {
        prompt: `Retry the step that failed: ${action.charAt(0).toLowerCase()}${action.slice(1)}.${error === undefined ? "" : ` It failed with: ${error}`}`,
      }),
    }));
    copyText = folded.items.flatMap((item) => item.kind === "text" ? [item.text] : []).join("\n\n");
    if (folded.failure !== undefined) reply.push(errorLine(folded.failure.error));
  }
  if (live !== undefined) {
    if (isActiveStatus(run.status) && (reply.length === 0 || live.cancelRequested)) {
      reply.push(h("div", { class: "note working" }, icon("circle-notch", { className: "spin" }),
        live.cancelRequested ? "Stopping" : run.status === "queued"
          ? (state.session?.workspaceMode === "isolated" ? "Preparing worktree" : "Starting") : "Working"));
    }
  } else {
    if (copyText === "") {
      const assistant = state.session?.messages.find((message) => message.role === "assistant" && message.metadata?.["runId"] === run.id);
      copyText = assistant?.content ?? run.result ?? "";
      if (copyText !== "") reply.push(h("div", { class: "md" }, renderMarkdown(copyText, actions)));
    }
    if (run.error !== undefined && folded?.failure === undefined) reply.push(errorLine(run.error));
    if (run.status === "interrupted" && !folded?.items.some((item) => item.kind === "status" && item.label === "interrupted")) reply.push(h("div", { class: "note" }, icon("stop-circle"), "Stopped"));
    if (run.status === "unknown") reply.push(h("div", { class: "note" }, icon("question"), "Ended without a final result. Review the activity before continuing."));
  }
  if (live?.fallbackFromAccountId !== undefined) {
    const from = state.accounts.find((candidate) => candidate.id === live.fallbackFromAccountId);
    reply.unshift(h("div", { class: "note" }, icon("info"),
      `${accountLabel(from, live.fallbackFromAccountId)} was unavailable; using ${accountLabel(account, run.accountId)}.`));
  }

  const active = isActiveStatus(run.status);
  // Edits appear once the response has finished, so the summary does not
  // grow and reflow while the agent is still working.
  const changes = active || folded === undefined ? [] : collectRunChanges(folded.items);
  if (changes.length > 0) reply.push(renderRunChanges(run.id, changes, memory, rerender, actions.openPath));
  // "Run again" sits under the final answer of the newest turn only: resending
  // an older prompt would append it after later turns and read out of order.
  const runAgain = !active && position.latest && run.prompt !== ""
    ? h("button", { class: "turn-action", type: "button", disabled: position.busy,
      title: position.busy ? "Wait for the current run to finish" : "Send this prompt again with the same model and settings",
      onClick: () => void controller.runAgain(run) }, icon("arrow-clockwise"), "Run again")
    : null;
  const meta = active ? h("div", { class: "run-progress", role: "status", aria: { label: live?.cancelRequested ? "Stopping" : "Run in progress" } },
    h("span", { class: "progress-dots", aria: { hidden: "true" } }, h("span"), h("span"), h("span")),
  ) : runAgain !== null
    // The newest turn's footer is just "Run again"; its time stays on hover.
    ? h("div", { class: "turn-meta", title: formatTime(run.createdAt) }, runAgain)
    : h("div", { class: "turn-meta" }, h("time", { class: "meta-time", title: run.createdAt }, formatTime(run.createdAt)));
  if (active) {
    // Streaming redraws rebuild the turn. Phase dots against the run timestamp
    // so their animation keeps advancing instead of restarting on each token.
    const elapsed = Math.max(0, Date.now() - Date.parse(run.createdAt)) || 0;
    meta.querySelectorAll<HTMLElement>(".progress-dots > span").forEach((dot, index) => {
      dot.style.animationDelay = `${-(elapsed % 1200) - (3 - index) * 150}ms`;
    });
  }

  // The article and reply container persist per run; only their children are
  // reconciled, so retained cards stay attached while text streams around them.
  let nodes = memory.turnNodes.get(run.id);
  if (nodes === undefined) {
    nodes = { article: h("article", { class: "turn", data: { runId: run.id } }), reply: h("div", { class: "reply" }) };
    memory.turnNodes.set(run.id, nodes);
  }
  reconcileChildren(nodes.reply, [...reply, meta]);
  const editor = memory.editor.current?.runId === run.id ? memory.editor.current : undefined;
  if (editor !== undefined) editor.update(turnsReplacedByEdit(state, run), edit === undefined ? "This message can no longer be edited." : edit.blocked);
  // Edit stays focusable while it is unavailable, so a keyboard user can be
  // resting on it when the turn ends and the prompt row is rebuilt; keep
  // their place instead of dropping focus to the document body.
  const editFocused = nodes.article.querySelector(".prompt-edit") === nodes.article.ownerDocument.activeElement;
  reconcileChildren(nodes.article, [
    editor?.element ?? renderPrompt(run, memory, rerender, controller, edit),
    ...(run.interactionMode === "plan" ? [h("div", { class: "turn-workflow note" }, icon("list-checks"), "Plan")] : []),
    nodes.reply,
  ]);
  if (editFocused && editor === undefined) nodes.article.querySelector<HTMLElement>(".prompt-edit")?.focus({ preventScroll: true });
  return nodes.article;
}

function renderPrompt(run: Pick<RunView, "id" | "prompt" | "attachments" | "editOfRunId">, memory: ViewMemory, rerender: () => void, controller?: Controller, edit?: PromptEdit): HTMLElement {
  const long = run.prompt.length > LONG_PROMPT_CHARS || run.prompt.split("\n").length > LONG_PROMPT_LINES;
  const expanded = memory.expandedPrompts.has(run.id);
  const edited = run.editOfRunId !== undefined;
  // Edit is revealed on hover or keyboard focus (see .prompt-actions) and
  // stays in the tab order, so it is reachable without a pointer. While it is
  // unavailable it uses aria-disabled rather than `disabled`: a disabled
  // button leaves the tab order, and keyboard and screen-reader users would
  // never learn why. The reason is its accessible description, the pointer
  // tooltip, and a visible hint while it has keyboard focus.
  const blocked = edit?.blocked;
  const reasonId = `prompt-edit-reason-${run.id}`;
  const actions = !edited && edit === undefined ? null : h("div", { class: "prompt-actions" },
    edited ? h("span", { class: "prompt-edited", title: "This message was edited and resent; the turns it replaced are kept in run history." }, "Edited") : null,
    blocked === undefined ? null : h("span", { class: "prompt-edit-reason", id: reasonId }, blocked),
    edit === undefined ? null : h("button", {
      class: "icon-button prompt-edit", type: "button",
      title: blocked ?? "Edit message",
      aria: blocked === undefined ? { label: "Edit message" } : { label: "Edit message", disabled: "true", describedby: reasonId },
      onClick: () => { if (blocked === undefined) edit.open(); },
    }, icon("pencil-simple")));
  return h("div", { class: actions === null ? "prompt-row" : "prompt-row has-actions" },
    h("div", { class: long && !expanded ? "bubble clipped" : "bubble" },
      run.prompt === "" ? null : h("div", { class: "bubble-text" }, run.prompt),
      (run.attachments?.length ?? 0) === 0 ? null : h("div", { class: "attachment-list turn-attachments", aria: { label: "Attached files" } },
        ...(run.attachments ?? []).map((file) => h("button", {
          class: "attachment-chip attachment-file", type: "button", title: file.path,
          aria: { label: `Open attachment ${file.name}` }, onClick: () => void controller?.openPath(file.path),
        }, icon("file-text"), h("span", { class: "attachment-name" }, file.name),
          h("span", { class: "attachment-size" }, formatAttachmentSize(file.size)))),
      ),
      !long ? null : h("button", {
        class: "bubble-toggle",
        onClick: () => {
          if (expanded) memory.expandedPrompts.delete(run.id);
          else memory.expandedPrompts.add(run.id);
          rerender();
        },
      }, expanded ? "Show less" : "Show full message"),
    ),
    actions,
  );
}

function renderItem(
  item: TranscriptItem, key: string, memory: ViewMemory,
  actions: MarkdownActions, active: boolean,
): Node {
  switch (item.kind) {
    case "text": return h("div", { class: "md" }, renderMarkdown(item.text, actions));
    case "thinking": return thinkingLine(item.text, item.format, actions);
    case "tool": return activityLine(key, memory, item, active, actions.openPath);
    case "tool_output": return activityLine(key, memory, {
      kind: "tool", tool: "Tool output", input: undefined, output: item.output, hasOutput: true, finished: true,
    }, false);
    case "status": return h("div", { class: "note" }, icon("info"), item.label, item.detail === undefined ? null : `: ${item.detail}`);
  }
}

/**
 * One compacted run of consecutive activity: tool calls, orphan outputs, and
 * the thinking between them, in their original order. The group starts
 * collapsed; its summary counts tool calls and thoughts and aggregates tool
 * status. Only the turn's newest group can be thinking: while the run is
 * active, it is the last thing in the reply, and its last item is a thought,
 * the status reads "Thinking". Earlier groups were followed by text or other
 * items, so their thinking has ended. A growing sequence keeps one stable key through
 * streaming redraws, and each entry keeps its own disclosure key inside.
 */
function renderActivityGroup(key: string, entries: readonly { key: string; item: ActivityItem }[], memory: ViewMemory, actions: MarkdownActions, active: boolean, latest: boolean): HTMLElement {
  const tools = entries.flatMap(({ item }) => item.kind === "thinking" ? [] : [asTool(item)]);
  const thoughts = entries.length - tools.length;
  const views = tools.map((item) => presentTool(item, active));
  const failed = views.filter((view) => view.status === "Failed").length;
  const running = views.filter((view) => view.status === "Running").length;
  const thinking = active && latest && running === 0 && entries.at(-1)?.item.kind === "thinking";
  const status = running > 0 ? `${running} running` : thinking ? "Thinking" : failed > 0 ? `${failed} failed`
    : views.some((view) => view.status === "Stopped") ? "Stopped" : views.every((view) => view.status === "Completed") ? "Completed" : "Recorded";
  const title = [
    `${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`,
    thoughts === 0 ? null : `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`,
  ].filter((part) => part !== null).join(" · ");
  const details = h("details", { class: `tool-group${failed > 0 ? " has-failures" : ""}`, open: memory.openToolGroups.has(key), data: { toolGroup: key } },
    h("summary", {}, icon("stack"), h("span", { class: "tool-group-title" }, title),
      h("span", { class: "tool-group-status" }, running > 0 || thinking ? icon("circle-notch", { className: "spin" }) : null, status),
      icon("caret-right", { className: "activity-caret" })),
    h("div", { class: "tool-group-body" }, ...entries.map((entry) => renderActivityEntry(entry, memory, actions, active))),
  );
  details.addEventListener("toggle", () => {
    // Detached disclosures can still deliver queued toggle events after a redraw.
    if (!details.isConnected) return;
    if (details.open) memory.openToolGroups.add(key); else memory.openToolGroups.delete(key);
  });
  return details;
}

/** One activity entry, standalone or inside a group. */
function renderActivityEntry(entry: { key: string; item: ActivityItem }, memory: ViewMemory, actions: MarkdownActions, active: boolean): HTMLElement {
  const { key, item } = entry;
  return item.kind === "thinking"
    ? thinkingLine(item.text, item.format, actions)
    : activityLine(key, memory, asTool(item), active, actions.openPath);
}

/** Orphan outputs render as a finished "Tool output" call. */
function asTool(item: Exclude<ActivityItem, { kind: "thinking" }>): Extract<TranscriptItem, { kind: "tool" }> {
  return item.kind === "tool" ? item : {
    kind: "tool", tool: "Tool output", input: undefined, output: item.output, hasOutput: true, finished: true,
  };
}

/** Activity starts as a compact status row; details appear only on user expansion. */
function activityLine(key: string, memory: ViewMemory, item: Extract<TranscriptItem, { kind: "tool" }>, active: boolean, openPath?: (path: string) => void): HTMLElement {
  const view = presentTool(item, active);
  const running = view.status === "Running";
  const details = h("details", { class: `activity-card${view.status === "Failed" ? " failed" : ""}`, open: memory.openTools.has(key) },
    h("summary", {},
      h("span", { class: "activity-icon" }, icon(view.icon)),
      h("span", { class: "activity-heading" },
        h("span", { class: "activity-title" }, view.title === "Run command"
          ? `${running ? "Running" : view.status === "Completed" ? "Ran" : view.status} command`
          : `${view.status} · ${view.title}`),
        view.subtitle === undefined ? null
          // File activity targets are clickable; the click must not also
          // toggle the surrounding <details> summary.
          : view.path !== undefined && openPath !== undefined
            ? h("code", { class: "activity-target activity-path", title: `Open ${view.path}`, role: "link", onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              openPath(view.path!);
            } }, view.subtitle)
            : h("code", { class: "activity-target", title: view.subtitle }, view.subtitle)),
      h("span", { class: "activity-meta" },
        view.duration === undefined ? null : h("span", {}, view.duration),
        view.exitCode === undefined ? null : h("span", {}, `exit ${view.exitCode}`),
        h("span", { class: "activity-status", title: view.status, aria: { label: view.status } }, icon(running ? "circle-notch" : view.status === "Failed" ? "x-circle" : view.status === "Stopped" ? "stop-circle" : view.status === "Completed" ? "check" : "question", { className: running ? "spin" : "" }))),
      icon("caret-right", { className: "activity-caret" })),
    h("div", { class: "activity-body" }, ...view.sections.map((section) => h("section", { class: "activity-section" },
      h("span", { class: "activity-section-label" }, section.label),
      section.format === "diff" ? h("pre", { class: "activity-diff" }, h("code", {}, ...section.text.split("\n").map((line) =>
        h("span", { class: /^(@@|---|\+\+\+)/.test(line) ? "diff-header" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "diff-context" }, line || " "))))
        : h("pre", { class: `activity-code activity-${section.format}` }, section.text),
    ))),
  );
  details.addEventListener("toggle", () => {
    if (!details.isConnected) return;
    if (details.open) memory.openTools.add(key); else memory.openTools.delete(key);
  });
  return details;
}

/**
 * Exposed thinking text, shown directly as muted prose beside a thin rule,
 * with no icon, label or collapse control. Summaries and readable traces must
 * stay distinguishable (architecture: runtime activity presentation), so the
 * kind is carried by the panel's accessible name and tooltip.
 */
function thinkingLine(text: string, format: "trace" | "summary" | undefined, actions: MarkdownActions): HTMLElement {
  const kind = format === "summary" ? "Reasoning summary" : format === "trace" ? "Thinking trace" : "Thinking";
  return h("div", { class: "thinking-panel", title: kind, role: "note", aria: { label: kind }, data: { format: format ?? "unknown" } },
    h("div", { class: "thinking-prose md" }, renderMarkdown(text, actions)));
}

/**
 * Collapsible summary of the files a finished response edited, placed at the
 * end of the reply. Collapsed by default. Inside, files and the selected
 * file's diff render through the Changes tab's own components
 * (`renderFileRow`/`renderFileDiff`), so rows, status letters, colors, font
 * sizes and the inline/split toggle match it exactly. Selection, split mode
 * and open state live in ViewMemory and survive redraws. Rows come from the
 * run's own tool activity (see run-changes.ts); the Changes tab remains the
 * complete working-tree view.
 */
const MAX_CHANGE_ROWS = 2000;
function renderRunChanges(runId: string, changes: readonly RunFileChange[], memory: ViewMemory, rerender: () => void, openPath?: (path: string) => void): HTMLElement {
  const key = `${runId}:changes`;
  const added = changes.reduce((sum, file) => sum + file.additions, 0);
  const removed = changes.reduce((sum, file) => sum + file.deletions, 0);
  const selected = changes.find((file) => file.path === memory.selectedChanges.get(runId));
  const select = (path?: string) => {
    if (path === undefined) memory.selectedChanges.delete(runId); else memory.selectedChanges.set(runId, path);
    rerender();
  };
  const list = h("div", { class: "git-file-list", role: "listbox", aria: { label: "Files changed in this reply" } },
    ...changes.map((file) => renderFileRow(file, file === selected, "changed in this reply", () => select(file.path))));
  const body = h("div", { class: "run-changes-body" }, list);
  if (selected !== undefined) {
    const rows = selected.rows.slice(0, MAX_CHANGE_ROWS);
    body.append(renderFileDiff({
      path: selected.path, status: selected.status, rows, source: "This reply",
      ...(rows.length < selected.rows.length ? { notice: `Showing the first ${MAX_CHANGE_ROWS} lines. Open the Changes tab for the full diff.` } : {}),
      split: memory.splitChanges.value,
      toggleSplit: () => { memory.splitChanges.value = !memory.splitChanges.value; rerender(); },
      openFile: (path) => openPath?.(path),
      close: () => select(undefined),
    }));
  }
  // Same keyboard model as the Changes tab file list.
  list.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".git-file-row")];
    const current = rows.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (current + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
    event.preventDefault(); rows[next]?.focus();
  });
  const details = h("details", { class: "run-changes", open: memory.openToolGroups.has(key), data: { runChanges: runId } },
    h("summary", {}, icon("git-diff"),
      h("span", { class: "run-changes-title" }, `${changes.length} ${changes.length === 1 ? "file" : "files"} changed`),
      h("span", { class: "run-changes-stats" }, h("span", { class: "added" }, `+${added}`), h("span", { class: "removed" }, `−${removed}`)),
      icon("caret-right", { className: "activity-caret" })),
    body);
  rememberOpen(details, key, memory.openToolGroups);
  return details;
}

/** Keeps a disclosure's open state in view memory across transcript redraws. */
function rememberOpen(details: HTMLDetailsElement, key: string, memory: Set<string>): void {
  details.addEventListener("toggle", () => {
    // Detached disclosures can still deliver queued toggle events after a redraw.
    if (!details.isConnected) return;
    if (details.open) memory.add(key); else memory.delete(key);
  });
}

/** Links open in the browser; paths open through main, relative to the session's project. */
function markdownActions(controller: Controller): MarkdownActions {
  return { openLink: (href) => controller.openExternal(href), openPath: (path) => void controller.openPath(path) };
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

/** One tick per turn; clicking a tick scrolls that turn into view. */
function renderRail(rail: HTMLElement, transcript: HTMLElement): void {
  const turns = [...transcript.querySelectorAll<HTMLElement>(".turn")];
  rail.hidden = turns.length < 2;
  replace(rail, ...turns.map((turn, index) => h("button", {
    class: "turn-tick",
    title: `Turn ${index + 1}`,
    aria: { label: `Go to turn ${index + 1}` },
    onClick: () => transcript.querySelectorAll<HTMLElement>(".turn")[index]?.scrollIntoView({ behavior: "smooth", block: "start" }),
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

/** A workflow is one user-facing turn even when it has many native threads. */
/**
 * A workflow turn reads like any other turn: the prompt bubble, then each
 * worker's activity in start order (thinking, tool group cards, text) through
 * the same `renderActivity` as ordinary runs, then the coordinator's answer.
 * The only addition is an indicator naming the workflow; it opens the run in
 * Orchestration. Workers stay attributed for assistive technology through a
 * labelled group that has no visual box (`display: contents`).
 *
 * Worker events come from the live store while a worker runs and from the
 * session's transcripts once settled; missing journals are requested through
 * `requestActivity`. Worker approvals are answered inline like a normal
 * turn's; workflow approval gates stay on the composer and in Orchestration.
 */
function renderWorkflowTurn(
  run: WorkflowRun,
  state: AppState,
  controller: Controller,
  fold: (id: string, events: readonly RuntimeEvent[]) => TurnActivity,
  memory: ViewMemory,
  rerender: () => void,
  requestActivity: (runIds: readonly string[]) => void,
): HTMLElement {
  const actions = markdownActions(controller);
  const active = isWorkflowActive(run);
  const reply: Node[] = [];
  const missing: string[] = [];
  let coordinatorReplied = false;
  for (const worker of run.workers) {
    const runId = worker.runId;
    if (runId === undefined) continue;
    const live = state.live[runId];
    const events = live?.events ?? state.transcripts[runId];
    if (events === undefined) { missing.push(runId); continue; }
    const activity = fold(runId, events);
    const running = live !== undefined && isActiveStatus(live.run.status);
    const nodes = renderActivity(activity, {
      runId, running, memory, actions, canRetry: false,
      pendingApprovalIds: new Set(live?.pendingApprovals.map((request) => request.id) ?? []),
      respond: (approvalId, decision) => controller.respondToApproval(runId, approvalId, decision),
    });
    if (worker.status === "failed" && activity.transcript.failure !== undefined) nodes.push(errorLine(activity.transcript.failure.error));
    if (worker.stepId === "coordinator" && activity.transcript.items.some((item) => item.kind === "text" && item.text.trim() !== "")) coordinatorReplied = true;
    if (nodes.length === 0) continue;
    let section = memory.workerNodes.get(worker.id);
    if (section === undefined) {
      section = h("div", { class: "workflow-worker", role: "group", aria: { label: worker.name }, data: { workerId: worker.id } });
      memory.workerNodes.set(worker.id, section);
    }
    reconcileChildren(section, nodes);
    reply.push(section);
  }
  if (missing.length > 0) requestActivity(missing);
  // Until the coordinator's journal is loaded, its saved answer stands in.
  const answer = state.session?.messages.find((message) => message.role === "assistant" && message.metadata?.["workflowRunId"] === run.id);
  if (!coordinatorReplied && answer !== undefined) reply.push(h("div", { class: "md" }, renderMarkdown(answer.content, actions)));
  if (run.error !== undefined) reply.push(errorLine(run.error));
  else if (run.status === "stopped") reply.push(h("div", { class: "note" }, icon("stop-circle"), "Stopped"));
  if (active && reply.length === 0) {
    reply.push(h("div", { class: "note working" }, icon("circle-notch", { className: "spin" }), run.status === "waiting_approval" ? "Waiting for your approval" : "Working"));
  }
  const meta = active ? h("div", { class: "run-progress", role: "status", aria: { label: "Workflow in progress" } },
    h("span", { class: "progress-dots", aria: { hidden: "true" } }, h("span"), h("span"), h("span")))
    : h("div", { class: "turn-meta" }, h("time", { class: "meta-time", title: run.createdAt }, formatTime(run.createdAt)));
  if (active) {
    const elapsed = Math.max(0, Date.now() - Date.parse(run.createdAt)) || 0;
    meta.querySelectorAll<HTMLElement>(".progress-dots > span").forEach((dot, index) => {
      dot.style.animationDelay = `${-(elapsed % 1200) - (3 - index) * 150}ms`;
    });
  }

  const key = `workflow:${run.id}`;
  let nodes = memory.turnNodes.get(key);
  if (nodes === undefined) {
    nodes = { article: h("article", { class: "turn orchestra-turn", id: `workflow-${run.id}`, data: { workflowRunId: run.id } }), reply: h("div", { class: "reply" }) };
    memory.turnNodes.set(key, nodes);
  }
  reconcileChildren(nodes.reply, [...reply, meta]);
  reconcileChildren(nodes.article, [
    renderPrompt({ id: run.id, prompt: run.prompt }, memory, rerender, controller),
    h("button", { class: "turn-workflow note workflow-indicator", type: "button", title: "Show this workflow in Orchestration",
      aria: { label: `Workflow ${run.workflow.name}. Show in Orchestration` },
      onClick: () => controller.openOrchestra({ sessionId: run.sessionId, workflowRunId: run.id }) },
    icon("flow-arrow"), h("span", {}, run.workflow.name)),
    nodes.reply,
  ]);
  return nodes.article;
}
