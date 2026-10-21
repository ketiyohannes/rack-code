/** Workflow library and live supervision. Execution belongs to the host and
 * continues when this panel closes or the renderer reconnects. */
import { isWorkflowActive, type WorkflowRun, type WorkflowWorker } from "../../../features/orchestration/types.js";
import type { Controller } from "../controller.js";
import type { HostClient } from "../host-client.js";
import type { Store } from "../store.js";
import { formatTime, h, replace } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { openModal } from "../components/modal.js";
import { renderMarkdown } from "../markdown.js";
import { openOrchestraEditor } from "./orchestra-editor.js";
import { workflowTemplate } from "./orchestra-templates.js";
import { createDropdown } from "../components/dropdown.js";

const STATUS_ICONS: Record<string, IconName> = { running: "circle-notch", queued: "clock", paused: "pause", waiting_approval: "hand", completed: "check-circle", failed: "warning-circle", stopped: "stop", interrupted: "warning-circle" };
export const workflowStatusLabel = (status: string): string => ({ waiting_approval: "Your approval", running: "Working", queued: "Waiting", paused: "Paused", completed: "Completed", failed: "Needs attention", stopped: "Stopped", interrupted: "Interrupted" })[status] ?? status;

export function createOrchestraPanel(store: Store, controller: Controller, host: HostClient): { element: HTMLElement; setActive(active: boolean): void } {
  const element = h("div", { class: "orchestra-panel" });
  let selectedRunId: string | undefined;
  let active = false;
  let signature = "";
  const heading = () => h("header", { class: "orchestra-panel-heading" }, h("div", {}, h("span", { class: "label" }, "AGENT ORCHESTRA"), h("h2", {}, "A process of your own.")), h("button", { class: "icon-button", type: "button", aria: { label: "Create workflow" }, onClick: () => openOrchestraEditor(workflowTemplate(), store, controller, host) }, icon("plus")));
  function render(): void {
    if (!active) return;
    const state = store.get(), sessionId = state.selection.sessionId;
    const workflows = [...state.orchestra.workflows].sort((a, b) => a.name.localeCompare(b.name));
    const bound = workflows.find((entry) => entry.id === (sessionId ? state.orchestra.bindings[sessionId] : undefined));
    const runs = state.orchestra.runs.filter((run) => run.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const running = runs.find(isWorkflowActive);
    const run = runs.find((entry) => entry.id === selectedRunId) ?? running ?? runs[0];
    // Tool deltas update the selected worker summary; ordinary chat streaming
    // must not continually replace this panel or steal focus.
    const key = JSON.stringify([sessionId, state.orchestra, selectedRunId, run?.workers.map((worker) => worker.runId ? state.live[worker.runId]?.events.at(-1)?.type : undefined)]);
    if (key === signature) return; signature = key;
    replace(element, heading());
    if (!sessionId) element.append(h("p", { class: "orchestra-callout" }, "Open a conversation to apply a workflow. Your library is available across projects."));
    if (sessionId) {
      const picker = createDropdown({ ariaLabel: "Session workflow", placeholder: "Choose a workflow", onChange: (value: string) => void controller.bindWorkflow(sessionId, value === "none" ? undefined : value) });
      picker.setOptions([{ value: "none", label: "Direct conversation" }, ...workflows.map((entry) => ({ value: entry.id, label: entry.name }))], bound?.id ?? "none");
      element.append(h("section", { class: "orchestra-session-binding" }, h("span", { class: "label" }, "FOR THIS CONVERSATION"), picker.element, h("p", { class: "note" }, bound ? "Your next message starts this workflow. Active runs keep their saved version." : "Choose a workflow, then send your task in the conversation.")));
    }
    if (run) {
      if (runs.length > 1) {
        const history = createDropdown({ ariaLabel: "Workflow run history", variant: "pill", onChange: (id: string) => { selectedRunId = id; signature = ""; render(); } });
        history.setOptions(runs.map((entry) => ({ value: entry.id, label: `${entry.workflow.name} · ${formatTime(entry.createdAt)}`, description: workflowStatusLabel(entry.status) })), run.id); element.append(history.element);
      }
      element.append(renderRun(run));
    }
    element.append(h("div", { class: "orchestra-library-heading" }, h("span", { class: "label" }, "SAVED WORKFLOWS"), h("span", { class: "orchestra-count" }, String(workflows.length))));
    if (!workflows.length) element.append(h("div", { class: "orchestra-empty" }, h("span", { class: "orchestra-empty-mark" }, icon("flow-arrow")), h("h3", {}, "Give your agents a rhythm."), h("p", {}, "Choose who plans, who builds, and who checks the work. Save it once. Run it in any conversation."), h("button", { class: "button button-primary", type: "button", onClick: () => openOrchestraEditor(workflowTemplate(), store, controller, host) }, icon("plus"), "Create your first workflow"), h("div", { class: "orchestra-empty-sequence" }, "PLAN", icon("arrow-right"), "BUILD", icon("arrow-right"), "REVIEW")));
    for (const definition of workflows) {
      const card = h("article", { class: `orchestra-library-card ${bound?.id === definition.id ? "applied" : ""}` },
        h("div", { class: "orchestra-library-card-heading" }, icon("flow-arrow"), h("strong", {}, definition.name), bound?.id === definition.id ? h("span", { class: "orchestra-applied" }, icon("check"), "Applied") : null),
        h("p", {}, definition.description || "A workflow of your own."),
        h("div", { class: "orchestra-mini-flow" }, ...definition.steps.flatMap((step, index) => [index ? icon("caret-right") : null, h("span", {}, step.name)])),
        h("div", { class: "orchestra-library-actions" }, h("span", { class: "note" }, `${definition.steps.reduce((sum, step) => sum + step.agents.length, 0)} agents · v${definition.revision}`),
          h("button", { class: "icon-button", type: "button", aria: { label: `Edit ${definition.name}` }, onClick: () => openOrchestraEditor(definition, store, controller, host) }, icon("pencil-simple")),
          h("button", { class: "icon-button", type: "button", aria: { label: `Duplicate ${definition.name}` }, onClick: () => openOrchestraEditor({ ...structuredClone(definition), id: crypto.randomUUID(), name: `${definition.name} copy`, revision: 0 }, store, controller, host) }, icon("copy")),
          h("button", { class: "icon-button", type: "button", aria: { label: `Delete ${definition.name}` }, onClick: () => {
            const modal = openModal({ title: "Delete workflow?", content: h("div", { class: "modal-body" }, h("p", {}, `Delete “${definition.name}” from your library? Existing run history is kept.`), h("button", { class: "button", type: "button", onClick: () => modal.close() }, "Cancel"), h("button", { class: "button button-primary", type: "button", onClick: async () => { await controller.removeWorkflow(definition.id); modal.close(); } }, "Delete workflow")) });
          } }, icon("trash-simple")),
          h("button", { class: "button button-small", type: "button", disabled: !sessionId || bound?.id === definition.id, onClick: () => { if (sessionId) void controller.bindWorkflow(sessionId, definition.id); } }, bound?.id === definition.id ? "Applied" : "Apply")));
      element.append(card);
    }
  }
  function renderRun(run: WorkflowRun): HTMLElement {
    const current = run.workflow.steps[run.stepIndex];
    return h("section", { class: "orchestra-live", aria: { label: "Workflow progress" } },
      h("div", { class: "orchestra-live-heading" }, h("strong", {}, run.workflow.name), h("span", { class: `orchestra-status ${run.status}` }, icon(STATUS_ICONS[run.status] ?? "clock"), workflowStatusLabel(run.status))),
      h("p", { class: "orchestra-task" }, run.prompt),
      isWorkflowActive(run) ? h("div", { class: "orchestra-live-controls" },
        run.status === "waiting_approval" ? h("button", { class: "button button-primary", type: "button", onClick: () => void controller.controlWorkflow(run.id, "approve") }, icon("check"), "Approve & continue") : h("button", { class: "button", type: "button", onClick: () => void controller.controlWorkflow(run.id, run.status === "paused" ? "resume" : "pause") }, icon(run.status === "paused" ? "play" : "pause"), run.status === "paused" ? "Resume" : "Pause"),
        h("button", { class: "button", type: "button", onClick: () => void controller.controlWorkflow(run.id, "stop") }, icon("stop"), "Stop")) : null,
      run.status === "paused" ? h("p", { class: "note" }, "Current agents can finish. New steps wait until you resume.") : null,
      run.error ? h("p", { class: "orchestra-callout error-line" }, run.error) : null,
      ...run.workflow.steps.map((step, index) => {
        const workers = run.workers.filter((worker) => worker.stepId === step.id);
        const latest = workers.at(-1);
        const status = index === run.stepIndex ? run.status === "waiting_approval" ? "waiting_approval" : latest?.status ?? "queued" : index < run.stepIndex ? "completed" : "queued";
        return h("div", { class: `orchestra-progress-step ${index === run.stepIndex && isWorkflowActive(run) ? "current" : ""}` },
          h("div", { class: "orchestra-progress-heading" }, icon(STATUS_ICONS[status] ?? "clock"), h("strong", {}, step.name), h("small", {}, step.kind === "parallel" ? "Parallel" : step.kind === "approval" ? "Approval" : "Agent")),
          ...workers.map((worker) => workerRow(worker, run)),
          !workers.length && index === run.stepIndex ? h("p", { class: "note" }, run.status === "waiting_approval" ? "Inspect the earlier results before continuing." : `Next: ${current?.name ?? "Coordinator"}`) : null);
      }), ...run.workers.filter((worker) => worker.stepId === "coordinator").map((worker) => workerRow(worker, run)));
  }
  function workerRow(worker: WorkflowWorker, run: WorkflowRun): HTMLElement {
    const live = worker.runId ? store.get().live[worker.runId] : undefined;
    const activity = [...(live?.events ?? [])].reverse().find((event) => event.type === "tool_request");
    return h("button", { class: "orchestra-worker", type: "button", onClick: () => inspectWorker(run, worker) },
      icon(STATUS_ICONS[worker.status] ?? "clock"), h("span", {}, h("strong", {}, worker.name, worker.round ? ` · revision ${worker.round}` : ""), h("small", {}, `${worker.model.model}${activity?.type === "tool_request" ? ` · ${activity.tool}` : ` · ${workflowStatusLabel(worker.status)}`}`)), icon("caret-right"));
  }
  function inspectWorker(run: WorkflowRun, selected: WorkflowWorker): void {
    const body = h("div", { class: "modal-body orchestra-worker-detail" });
    let unsubscribe: (() => void) | undefined;
    const modal = openModal({ title: selected.name, className: "orchestra-worker-modal", content: body, onClose: () => unsubscribe?.() });
    let journal: readonly { type: string; payload: unknown }[] = [];
    const renderDetail = () => {
      const worker = store.get().orchestra.runs.find((entry) => entry.id === run.id)?.workers.find((entry) => entry.id === selected.id) ?? selected;
      const live = worker.runId ? store.get().live[worker.runId] : undefined;
      const events = live?.events ?? journal.map((entry) => entry.payload as { type: string; tool?: string; text?: string; output?: unknown });
      const scroll = body.scrollTop;
      replace(body, h("div", { class: "orchestra-detail-meta" }, h("span", { class: "orchestra-status" }, icon(STATUS_ICONS[worker.status] ?? "clock"), workflowStatusLabel(worker.status)), h("span", {}, worker.model.model), h("span", {}, formatTime(worker.createdAt))),
        h("span", { class: "label" }, "ASSIGNMENT"), h("p", { class: "orchestra-instructions" }, worker.instructions),
        worker.error ? h("p", { class: "error-line" }, worker.error) : null,
        h("span", { class: "label" }, "ACTIVITY"),
        ...events.filter((event) => ["tool_request", "tool_result"].includes(event.type)).slice(-80).map((event) => h("details", { class: "orchestra-tool" }, h("summary", {}, icon("wrench"), "tool" in event ? String(event.tool) : "Tool result"), h("pre", {}, JSON.stringify(event, null, 2)))),
        h("span", { class: "label" }, "RESULT"), h("div", { class: "markdown" }, renderMarkdown(worker.result ?? (live?.events.filter((event) => event.type === "message_delta").map((event) => event.text).join("") || "No result yet."), (href) => void controller.openPath(href))),
        live ? h("button", { class: "button", type: "button", onClick: () => { if (worker.runId) void controller.cancelRun(worker.runId); } }, icon("stop"), "Stop agent") : null);
      body.scrollTop = scroll;
    };
    unsubscribe = store.watch((state) => [state.orchestra, state.live], renderDetail);
    if (selected.runId) void host.call("runs.journal", { runId: selected.runId }).then((entries) => { journal = entries; if (body.isConnected) renderDetail(); }).catch((error) => { if (body.isConnected) body.append(h("p", { class: "error-line" }, `Could not load saved activity: ${error instanceof Error ? error.message : String(error)}`)); });
    void modal;
  }
  store.watch((state) => [state.orchestra, state.selection.sessionId, state.live], render);
  return { element, setActive(value) { if (active === value) return; active = value; if (value) { signature = ""; render(); } } };
}
