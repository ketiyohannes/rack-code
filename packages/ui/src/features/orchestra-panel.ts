/**
 * Orchestration sidebar.
 *
 * Two states only:
 * - Idle: the saved workflow titles, nothing else. Selecting a title applies
 *   it to the open conversation's next message (selecting it again removes
 *   it). Edit/delete appear on hover or keyboard focus; "+" creates one.
 * - Running: the active workflow's agents in order. Each agent shows its model
 *   and a collapsible waterfall of the tools it called, streaming in as they
 *   start. Running agents stay open; an agent collapses with an animation when
 *   it settles unless the user chose otherwise. A finished run can still be
 *   inspected through exact navigation (transcript/Timeline links), with Back
 *   returning to the titles.
 *
 * Rendering is keyed and incremental: agent and tool nodes persist across
 * updates, so entry animations play once and spinners never restart. Spinners
 * are phase-locked to the clock for the same reason. Ordinary response text is
 * ignored; only tool activity and lifecycle changes update the view.
 *
 * Execution and pending requests belong to the host. Worker approvals and
 * questions are answered through broker-owned forms above the composer; this
 * panel only links to them. Settled workers' events leave the live store, so
 * the panel caches what it observed and lazily loads saved journals for
 * workers that finished before it was opened.
 */
import { isWorkflowActive, type WorkflowDefinition, type WorkflowRun, type WorkflowWorker } from "@rack/features/orchestration/types";
import type { RuntimeEvent } from "@rack/contracts";
import type { Controller } from "../controller.js";
import type { HostClient } from "@rack/client/host-client";
import type { AppState, Store } from "../store.js";
import { h, replace } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { openModal } from "../components/modal.js";
import { eventsFromJournal } from "../transcript.js";
import { openOrchestraEditor } from "./orchestra-editor.js";
import { workflowTemplate } from "./orchestra-templates.js";
import { workflowRequiredActions, type WorkflowRequiredAction } from "./orchestra-state.js";
import { workerDetail } from "./orchestra-worker-state.js";

export const workflowStatusLabel = (status: string): string => ({ waiting_approval: "Your approval", running: "Working", queued: "Waiting", paused: "Paused", completed: "Completed", failed: "Needs attention", stopped: "Stopped", interrupted: "Interrupted" })[status] ?? status;

/** Newest tool rows kept per agent; older ones are summarized in one line. */
const MAX_TOOL_ROWS = 60;
const SETTLED: readonly string[] = ["completed", "failed", "stopped"];

/** A spinner whose rotation continues from the clock, so a rebuilt node does
 * not visibly restart (the old panel rebuilt everything and looked frozen). */
function spinner(): HTMLElement {
  const node = h("span", { class: "orchestra-spinner", aria: { hidden: "true" } });
  node.style.animationDelay = `-${Math.round(performance.now() % 900)}ms`;
  return node;
}

/** Status glyph for agents and tools: animated while work is in flight. */
function statusMark(status: string): HTMLElement {
  if (status === "running" || status === "Running") return spinner();
  const name: IconName = status === "completed" || status === "Completed" ? "check-circle"
    : status === "failed" || status === "Failed" ? "warning-circle"
      : status === "stopped" || status === "Stopped" || status === "Incomplete" ? "stop-circle" : "clock";
  return h("span", { class: `orchestra-mark ${status.toLowerCase()}`, aria: { hidden: "true" } }, icon(name));
}

interface ToolNode { readonly row: HTMLElement; status: string; text: string }
interface AgentNode {
  readonly details: HTMLDetailsElement;
  readonly summary: HTMLElement;
  readonly list: HTMLElement;
  readonly working: HTMLElement;
  readonly overflow: HTMLElement;
  readonly tools: Map<string, ToolNode>;
  status: string;
  /** The `open` value the panel last set itself. Toggle events are async, so a
   * toggle that lands on this value is the panel's own change, not a user's. */
  expectedOpen: boolean;
  summaryKey: string;
  toolsKey: string;
}

export function createOrchestraPanel(store: Store, controller: Controller, host: HostClient): { element: HTMLElement; setActive(active: boolean): void } {
  const heading = h("header", { class: "orchestra-panel-heading" });
  const content = h("div", { class: "orchestra-panel-content" });
  const announcement = h("span", { class: "orchestra-announcement", role: "status", aria: { live: "polite", atomic: "true" } });
  const element = h("div", { class: "orchestra-panel" }, heading, content, announcement);

  let active = false;
  let targetSeq = 0;
  /** Finished run opened by exact navigation, per session; cleared by Back. */
  const viewed = new Map<string, string>();
  const bindingActions = new Map<string, { pending: boolean; error?: string }>();
  /** Worker execution events observed live or loaded from saved journals. */
  const events = new Map<string, readonly RuntimeEvent[]>();
  const loading = new Set<string>();
  /** Explicit open/closed choices by worker; absent means automatic. */
  const openChoice = new Map<string, boolean>();

  // Mounted view state. `mounted` names what content currently shows.
  let mounted = "";
  let librarySignature = "";
  let runHeader: HTMLElement | undefined;
  let runActions: HTMLElement | undefined;
  let runAgents: HTMLElement | undefined;
  let headerKey = "";
  let actionsKey = "";
  const agents = new Map<string, AgentNode>();

  function createWorkflow(): void { openOrchestraEditor(workflowTemplate(), store, controller, host); }

  function render(): void {
    if (!active) return;
    const state = store.get(), sessionId = state.selection.sessionId;
    const runs = state.orchestra.runs.filter((run) => run.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const target = state.orchestraTarget;
    if (target && target.seq !== targetSeq && target.sessionId === sessionId && runs.some((run) => run.id === target.workflowRunId)) {
      targetSeq = target.seq;
      viewed.set(target.sessionId, target.workflowRunId);
      if (target.workerId) openChoice.set(target.workerId, true);
    }
    const running = runs.find((run) => isWorkflowActive(run) || state.workflowControls?.[run.id]?.pending);
    const run = running ?? (sessionId ? runs.find((entry) => entry.id === viewed.get(sessionId)) : undefined);
    if (run) renderRun(run, state, running === undefined);
    else renderLibrary(state, sessionId);
  }

  // ---------------------------------------------------------------------------
  // Idle: workflow titles only

  function renderLibrary(state: AppState, sessionId: string | undefined): void {
    const workflows = [...state.orchestra.workflows].sort((a, b) => a.name.localeCompare(b.name));
    const bound = sessionId ? state.orchestra.bindings[sessionId] : undefined;
    const binding = sessionId ? bindingActions.get(sessionId) : undefined;
    const key = JSON.stringify([sessionId, workflows.map((entry) => [entry.id, entry.name]), bound, binding, state.host.status]);
    if (mounted === "library" && key === librarySignature) return;
    const focused = element.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.uiKey : undefined;
    mounted = "library"; librarySignature = key; agents.clear();
    replace(heading, h("h2", {}, "Orchestration"),
      h("button", { class: "icon-button", type: "button", data: { uiKey: "new-workflow" }, aria: { label: "Create workflow" }, title: "Create workflow", onClick: createWorkflow }, icon("plus")));
    replace(content);
    if (state.host.status !== "ready") content.append(h("p", { class: "orchestra-callout", role: "status" }, state.host.status === "connecting" ? "Connecting to Rack…" : "Execution host disconnected."));
    if (binding?.error) content.append(h("p", { class: "error-line", role: "alert" }, binding.error));
    if (workflows.length === 0) {
      content.append(h("button", { class: "quiet-button orchestra-create", type: "button", data: { uiKey: "create-first" }, onClick: createWorkflow }, icon("plus"), "Create workflow"));
    } else {
      content.append(h("ul", { class: "orchestra-titles", aria: { label: "Workflows" } }, ...workflows.map((definition) => titleRow(definition, sessionId, bound === definition.id, !!binding?.pending))));
    }
    if (focused) [...element.querySelectorAll<HTMLElement>("[data-ui-key]")].find((node) => node.dataset.uiKey === focused)?.focus({ preventScroll: true });
  }

  function titleRow(definition: WorkflowDefinition, sessionId: string | undefined, applied: boolean, pending: boolean): HTMLElement {
    return h("li", { class: `orchestra-title-row${applied ? " applied" : ""}` },
      h("button", {
        class: "orchestra-title", type: "button", disabled: !sessionId || pending, data: { uiKey: `title:${definition.id}` },
        aria: { pressed: String(applied), label: `${definition.name}${applied ? ", applied to your next message" : ""}` },
        title: !sessionId ? "Open a conversation to apply a workflow" : applied ? "Applied to your next message. Select to remove." : "Apply to your next message",
        onClick: () => { if (sessionId) void changeBinding(sessionId, applied ? undefined : definition.id); },
      }, h("span", { class: "orchestra-title-text" }, definition.name), applied ? icon("check", { className: "orchestra-applied-mark" }) : null),
      h("span", { class: "orchestra-title-actions" },
        h("button", { class: "icon-button", type: "button", data: { uiKey: `edit:${definition.id}` }, aria: { label: `Edit ${definition.name}` }, title: "Edit", onClick: () => openOrchestraEditor(definition, store, controller, host) }, icon("pencil-simple")),
        h("button", { class: "icon-button", type: "button", data: { uiKey: `delete:${definition.id}` }, aria: { label: `Delete ${definition.name}` }, title: "Delete", onClick: () => confirmDelete(definition.id, definition.name) }, icon("trash-simple"))));
  }

  /** Binding is an explicit next-message choice; feedback stays with its session. */
  async function changeBinding(sessionId: string, workflowId?: string): Promise<void> {
    if (bindingActions.get(sessionId)?.pending) return;
    bindingActions.set(sessionId, { pending: true }); render();
    await controller.bindWorkflow(sessionId, workflowId);
    const accepted = store.get().orchestra.bindings[sessionId] === workflowId;
    bindingActions.set(sessionId, { pending: false, ...(accepted ? {} : { error: "Could not apply this workflow. Check the connection and try again." }) });
    render();
  }

  function confirmDelete(workflowId: string, name: string): void {
    const error = h("p", { class: "error-line", role: "alert" });
    const remove = h("button", { class: "button button-primary", type: "button", onClick: async () => {
      if (remove.disabled) return;
      remove.disabled = true; remove.textContent = "Deleting…"; error.textContent = "";
      await controller.removeWorkflow(workflowId);
      if (!store.get().orchestra.workflows.some((entry) => entry.id === workflowId)) modal.close();
      else { remove.disabled = false; remove.textContent = "Delete workflow"; error.textContent = "Could not delete this workflow. Check the connection and try again."; }
    } }, "Delete workflow");
    const modal = openModal({ title: "Delete workflow?", content: h("div", { class: "modal-body" }, h("p", {}, `Delete “${name}” from your library? Existing run history is kept.`), error,
      h("div", { class: "modal-actions" }, h("button", { class: "button", type: "button", onClick: () => modal.close() }, "Cancel"), remove)) });
  }

  // ---------------------------------------------------------------------------
  // Running: agents, models and the tool waterfall

  function renderRun(run: WorkflowRun, state: AppState, finished: boolean): void {
    if (mounted !== `run:${run.id}`) {
      mounted = `run:${run.id}`; librarySignature = ""; headerKey = ""; actionsKey = ""; agents.clear();
      runHeader = h("div", { class: "orchestra-run-header" });
      runActions = h("div", { class: "orchestra-run-actions" });
      runAgents = h("div", { class: "orchestra-agents", aria: { label: "Agents" } });
      replace(heading, h("h2", {}, "Orchestration"));
      replace(content, h("section", { class: "orchestra-run", aria: { label: "Workflow progress" } }, runHeader, runActions, runAgents));
    }
    const control = state.workflowControls?.[run.id];
    const stopping = control?.pending && control.action === "stop";
    const status = stopping ? "Stopping" : workflowStatusLabel(run.status);

    const nextHeader = JSON.stringify([run.workflow.name, run.status, status, control, finished, run.error]);
    if (nextHeader !== headerKey) {
      headerKey = nextHeader;
      const working = run.status === "running" && !stopping;
      replace(runHeader!,
        finished ? h("button", { class: "icon-button orchestra-back", type: "button", aria: { label: "Back to workflows" }, title: "Back to workflows", onClick: () => { viewed.delete(run.sessionId); render(); } }, icon("arrow-left")) : null,
        h("div", { class: "orchestra-run-title" }, h("h3", {}, run.workflow.name),
          h("span", { class: `orchestra-run-status ${stopping ? "stopping" : run.status}` }, working || stopping ? spinner() : statusMark(run.status), status)),
        finished ? null : h("span", { class: "orchestra-run-controls" },
          run.status === "running" || run.status === "paused" ? h("button", { class: "icon-button", type: "button", disabled: !!control?.pending,
            aria: { label: run.status === "paused" ? "Resume workflow" : "Pause workflow" }, title: run.status === "paused" ? "Resume" : "Pause: current agents finish, new steps wait",
            onClick: () => void controller.controlWorkflow(run.id, run.status === "paused" ? "resume" : "pause") }, icon(run.status === "paused" ? "play" : "pause")) : null,
          h("button", { class: "icon-button", type: "button", disabled: !!control?.pending, aria: { label: "Stop workflow" }, title: "Stop workflow",
            onClick: () => void controller.controlWorkflow(run.id, "stop") }, icon("stop"))));
      const label = `${run.workflow.name}: ${status}`;
      if (announcement.textContent !== label) announcement.textContent = label;
    }

    const required = finished ? [] : workflowRequiredActions(state, run);
    const nextActions = JSON.stringify([required, control?.error, run.error, control?.pending]);
    if (nextActions !== actionsKey) {
      actionsKey = nextActions;
      replace(runActions!, ...required.map(requiredAction),
        control?.error ? h("p", { class: "error-line", role: "alert" }, control.error) : null,
        run.error ? h("p", { class: "orchestra-callout error-line", role: "alert" }, run.error) : null);
    }

    for (const worker of run.workers) updateAgent(worker, state);
  }

  /** Required actions link to broker-owned forms; workflow gates approve here. */
  function requiredAction(action: WorkflowRequiredAction): HTMLElement {
    const gate = action.kind === "workflow_approval";
    return h("div", { class: "orchestra-required-action" }, icon(gate ? "hand" : action.kind === "question" ? "question" : "shield-check"),
      h("span", {}, gate ? "Your approval is needed" : `${action.workerName} needs ${action.kind === "question" ? "an answer" : "tool approval"}`),
      h("button", { class: "button button-small", type: "button", disabled: gate && !!store.get().workflowControls?.[action.target.workflowRunId]?.pending,
        onClick: () => {
          if (gate) { void controller.controlWorkflow(action.target.workflowRunId, "approve"); return; }
          const card = [...document.querySelectorAll<HTMLElement>("[data-pending-request]")].find((node) => node.dataset.pendingRequest === action.requestId && node.dataset.executionId === action.executionId);
          card?.scrollIntoView({ block: "nearest" });
          // Questions focus their first input; inline tool approvals their
          // first decision button (Deny) rather than the details toggle.
          (card?.querySelector<HTMLElement>("input, button.button:not(:disabled)") ?? card?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
        } }, gate ? "Approve & continue" : action.kind === "question" ? "Answer" : "Review"));
  }

  function modelLabel(worker: WorkflowWorker): string {
    const model = worker.model;
    const name = store.get().models.find((entry) => entry.id === model.model && entry.runtimeId === model.runtimeId && entry.providerId === model.providerId)?.label
      ?? (model.model === "default" ? "Default model" : model.model);
    return model.reasoningEffort ? `${name} · ${model.reasoningEffort}` : name;
  }

  /** Events for one worker execution: live first, then cached/saved. */
  function workerEvents(worker: WorkflowWorker, state: AppState): readonly RuntimeEvent[] {
    if (!worker.runId) return [];
    const live = state.live[worker.runId];
    if (live) { events.set(worker.runId, live.events); return live.events; }
    const cached = events.get(worker.runId);
    if (cached) return cached;
    if (SETTLED.includes(worker.status) && !loading.has(worker.runId)) {
      const runId = worker.runId;
      loading.add(runId);
      void host.call("runs.journal", { runId }).then((entries) => { events.set(runId, eventsFromJournal(entries)); }, () => { events.set(runId, []); })
        .finally(() => { loading.delete(runId); render(); });
    }
    return [];
  }

  function updateAgent(worker: WorkflowWorker, state: AppState): void {
    let node = agents.get(worker.id);
    if (!node) {
      const summary = h("summary", {});
      const list = h("ol", { class: "orchestra-waterfall" });
      const working = h("li", { class: "orchestra-tool-row working" }, h("span", { class: "orchestra-node" }, spinner()), h("span", { class: "orchestra-shimmer" }, "Working…"));
      const overflow = h("li", { class: "orchestra-tool-overflow" });
      const details = h("details", { class: "orchestra-agent", data: { workerId: worker.id } }, summary, h("div", { class: "orchestra-agent-body" }, list)) as HTMLDetailsElement;
      details.open = openChoice.get(worker.id) ?? !SETTLED.includes(worker.status);
      node = { details, summary, list, working, overflow, tools: new Map(), status: "", expectedOpen: details.open, summaryKey: "", toolsKey: "" };
      const agent = node;
      // Only user toggles become explicit choices; the initial state and the
      // automatic collapse on settlement must not count as one.
      details.addEventListener("toggle", () => {
        if (details.open === agent.expectedOpen) return;
        agent.expectedOpen = details.open;
        openChoice.set(worker.id, details.open);
      });
      agents.set(worker.id, node);
      runAgents!.append(details);
    }
    const live = worker.runId ? state.live[worker.runId] : undefined;
    const source = workerEvents(worker, state);
    // Settling collapses the agent (animated by CSS) unless the user chose.
    if (node.status !== worker.status) {
      if (node.status !== "" && SETTLED.includes(worker.status) && !openChoice.has(worker.id) && node.details.open) { node.expectedOpen = false; node.details.open = false; }
      node.status = worker.status;
      node.details.className = `orchestra-agent ${worker.status}`;
    }

    // Tool activity only; streamed response text never reaches this key.
    let toolEvents = 0;
    for (const event of source) if (event.type === "tool_request" || event.type === "tool_result") toolEvents++;
    const toolsKey = `${worker.status}|${source.length === 0 ? 0 : toolEvents}|${live?.cancelRequested ? 1 : 0}`;
    if (toolsKey === node.toolsKey) return;
    node.toolsKey = toolsKey;
    const tools = workerDetail(worker, source, live).tools;
    const shown = tools.slice(-MAX_TOOL_ROWS);

    const summaryKey = `${worker.status}|${worker.name}|${worker.round}|${modelLabel(worker)}|${tools.length}`;
    if (summaryKey !== node.summaryKey) {
      node.summaryKey = summaryKey;
      replace(node.summary, statusMark(worker.status),
        h("span", { class: "orchestra-agent-name" }, worker.name, worker.round ? h("small", {}, ` · revision ${worker.round}`) : null),
        h("span", { class: "orchestra-agent-model", title: modelLabel(worker) }, modelLabel(worker)),
        tools.length ? h("span", { class: "orchestra-agent-count", aria: { label: `${tools.length} tool calls` } }, String(tools.length)) : null,
        icon("caret-right", { className: "orchestra-agent-caret" }));
    }

    const keep = new Set(shown.map((tool) => tool.key));
    for (const [key, entry] of node.tools) if (!keep.has(key)) { entry.row.remove(); node.tools.delete(key); }
    let entering = 0;
    for (const tool of shown) {
      const view = tool.presentation;
      const text = `${view.title}|${view.subtitle ?? ""}`;
      let entry = node.tools.get(tool.key);
      if (!entry) {
        const row = h("li", { class: "orchestra-tool-row entering" });
        // Stagger rows that arrive together into a waterfall.
        row.style.setProperty("--enter-delay", `${Math.min(entering++, 8) * 55}ms`);
        row.addEventListener("animationend", () => row.classList.remove("entering"), { once: true });
        entry = { row, status: "", text: "" };
        node.tools.set(tool.key, entry);
        node.list.insertBefore(row, node.working.isConnected ? node.working : null);
      }
      if (entry.status !== view.status || entry.text !== text) {
        entry.status = view.status; entry.text = text;
        entry.row.dataset.status = view.status.toLowerCase();
        // The node masks the waterfall rail behind the mark without painting
        // over the spinner's own gradient.
        replace(entry.row, h("span", { class: "orchestra-node" }, statusMark(view.status)),
          h("span", { class: "orchestra-tool-title" }, view.title),
          view.subtitle ? h("code", { class: "orchestra-tool-target", title: view.subtitle }, view.subtitle.replace(/\s+/g, " ").slice(0, 240)) : null);
      }
    }
    node.overflow.textContent = tools.length > shown.length ? `${tools.length - shown.length} earlier tool calls` : "";
    if (tools.length > shown.length) node.list.prepend(node.overflow); else node.overflow.remove();
    // While the agent works without a tool in flight, show a live "Working" row.
    const toolRunning = shown.some((tool) => tool.presentation.status === "Running");
    const thinking = (worker.status === "running" || worker.status === "queued") && !toolRunning && !live?.cancelRequested;
    // New tool rows are inserted before it, so it stays last without moving
    // (moving a node would restart its animations).
    if (thinking && !node.working.isConnected) { node.working.querySelector(".orchestra-spinner")?.replaceWith(spinner()); node.list.append(node.working); }
    else if (!thinking) node.working.remove();
  }

  store.watch((state) => [state.orchestra, state.selection.sessionId, state.live, state.orchestraTarget, state.workflowControls, state.host.status, state.models], render);
  return { element, setActive(value) {
    if (active === value) return;
    active = value;
    if (value) { mounted = ""; render(); }
  } };
}
