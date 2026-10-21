/** Card-based workflow authoring. The canvas and inspector edit one definition;
 * moving cards changes execution order, never just their screen positions. */
import { validateWorkflow, type AgentModel, type WorkflowAgent, type WorkflowDefinition, type WorkflowStep } from "../../../features/orchestration/types.js";
import type { Controller } from "../controller.js";
import type { HostClient } from "../host-client.js";
import type { Store } from "../store.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openModal } from "../components/modal.js";
import { createDropdown } from "../components/dropdown.js";
import { modelKey } from "../components/model-settings.js";
import { agentStep, workflowTemplate } from "./orchestra-templates.js";

export function openOrchestraEditor(initial: WorkflowDefinition, store: Store, controller: Controller, host: HostClient): void {
  let draft = structuredClone(initial);
  let selected = draft.steps[0]?.id ?? "coordinator";
  let selectedAgent = 0;
  let busy = false;
  let dragging: string | undefined;
  let cancelDrag: (() => void) | undefined;
  const canvas = h("div", { class: "orchestra-canvas", aria: { label: "Workflow steps" } });
  const inspector = h("aside", { class: "orchestra-inspector", aria: { label: "Step settings" } });
  const error = h("p", { class: "error-line", role: "alert" });
  const name = h("input", { class: "orchestra-name", value: draft.name, aria: { label: "Workflow name" }, onInput: () => { draft = { ...draft, name: name.value }; } });
  const description = h("input", { class: "orchestra-description", value: draft.description, placeholder: "What does this orchestra do?", aria: { label: "Workflow description" }, onInput: () => { draft = { ...draft, description: description.value }; } });
  const prompt = h("textarea", { rows: 2, placeholder: "Describe your workflow. Who should work, in what order, and when should they ask you?", aria: { label: "Describe a workflow" } });
  const generate = h("button", { class: "button", type: "button", onClick: () => void generateDraft() }, icon("sparkle"), "Generate draft");
  const availableModels = store.get().models;
  const firstDraftModel = availableModels.find((model) => store.get().favoriteModelKeys.includes(modelKey(model))) ?? availableModels[0];
  let draftingModel: AgentModel | undefined = draft.coordinator ?? (firstDraftModel ? { providerId: firstDraftModel.providerId, runtimeId: firstDraftModel.runtimeId, model: firstDraftModel.id } : undefined);
  const draftingPicker = createDropdown({ ariaLabel: "Workflow drafting model", variant: "pill", placeholder: "Connect a model to generate", onChange: (key: string) => {
    const model = availableModels.find((entry) => modelKey(entry) === key);
    draftingModel = model ? { providerId: model.providerId, runtimeId: model.runtimeId, model: model.id } : undefined;
  } });
  draftingPicker.setOptions(availableModels.map((model) => ({ value: modelKey(model), label: model.label, group: model.providerName })), draftingModel ? `${draftingModel.providerId}|${draftingModel.runtimeId}|${draftingModel.model}` : undefined);
  const save = h("button", { class: "button button-primary", type: "button", onClick: () => void saveDraft() }, icon("floppy-disk"), "Save workflow");
  const content = h("div", { class: "orchestra-studio" },
    h("header", { class: "orchestra-studio-heading" }, h("div", {}, h("span", { class: "label" }, "YOUR PROCESS, YOUR MODELS"), name, description)),
    h("div", { class: "orchestra-studio-body" }, h("div", { class: "orchestra-stage" },
      h("details", { class: "orchestra-generate" }, h("summary", {}, icon("sparkle"), "Describe it to build it", icon("caret-down")), h("div", {}, prompt, h("div", { class: "orchestra-draft-actions" }, draftingPicker.element, generate))),
      h("div", { class: "orchestra-templates" }, h("span", {}, "Start with"), ...([['feature', 'Feature'], ['review', 'Review'], ['research', 'Research']] as const).map(([kind, title]) => h("button", { class: "orchestra-template", type: "button", onClick: () => {
        draft = { ...workflowTemplate(kind), id: draft.id, revision: draft.revision, ...(draft.coordinator === undefined ? {} : { coordinator: draft.coordinator }) }; name.value = draft.name; description.value = draft.description; selected = draft.steps[0]!.id; selectedAgent = 0; redraw();
      } }, title))), canvas), inspector),
    h("footer", { class: "orchestra-studio-footer" }, h("div", {}, error, h("span", { class: "note" }, "Saved changes apply to future runs. Active runs keep their original version.")),
      h("button", { class: "button", type: "button", onClick: () => modal.close() }, "Cancel"), save));
  const modal = openModal({ title: "Workflow studio", className: "orchestra-modal", content, onClose: () => cancelDrag?.() });

  function setStep(step: WorkflowStep): void { draft = { ...draft, steps: draft.steps.map((entry) => entry.id === step.id ? step : entry) }; drawCanvas(); }
  function choose(id: string): void { selected = id; selectedAgent = 0; redraw(); }
  function move(id: string, offset: number): void {
    const steps = [...draft.steps], index = steps.findIndex((entry) => entry.id === id), destination = index + offset;
    if (destination < 0 || destination >= steps.length) return;
    const [step] = steps.splice(index, 1); steps.splice(destination, 0, step!); draft = { ...draft, steps }; drawCanvas();
  }
  function add(kind: WorkflowStep["kind"]): void {
    const step = kind === "approval" ? { id: crypto.randomUUID(), name: "Your approval", kind, agents: [] } : kind === "parallel"
      ? { id: crypto.randomUUID(), name: "Run together", kind, agents: [agentStep("Researcher", "Investigate this task and return evidence.", "read_only").agents[0]!, agentStep("Second perspective", "Independently investigate this task and check assumptions.", "read_only").agents[0]!] }
      : agentStep();
    draft = { ...draft, steps: [...draft.steps, step] }; selected = step.id; selectedAgent = 0; redraw(); canvas.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
  function drawCanvas(): void {
    replace(canvas,
      h("button", { class: `orchestra-conductor ${selected === "coordinator" ? "selected" : ""}`, type: "button", onClick: () => choose("coordinator") }, icon("flow-arrow"), h("span", {}, h("strong", {}, "Coordinator"), h("small", {}, "Brings the results back to your conversation")), h("span", { class: "orchestra-model-label" }, draft.coordinator ? modelLabel(draft.coordinator) : "Session model")),
      h("div", { class: "orchestra-flow-label" }, h("span", { class: "label" }, "EXECUTION FLOW"), h("span", {}, `${draft.steps.length} steps`)),
      ...draft.steps.map((step, index) => {
        const select = h("button", { class: "orchestra-step-main", type: "button", onClick: () => choose(step.id) },
          h("span", { class: "orchestra-step-number" }, String(index + 1).padStart(2, "0")),
          h("span", { class: "orchestra-step-copy" }, h("strong", {}, step.name), h("small", {}, step.kind === "approval" ? "Waits for your approval" : step.kind === "parallel" ? `${step.agents.length} agents · run together · read-only` : step.agents[0]?.instructions || "Add instructions")),
          icon(step.kind === "approval" ? "hand" : step.kind === "parallel" ? "stack" : "robot"));
        const card = h("div", { class: `orchestra-step ${step.kind} ${selected === step.id ? "selected" : ""}`, data: { stepId: step.id } }, select,
          step.kind === "approval" ? null : h("div", { class: "orchestra-step-models" }, ...step.agents.map((agent) => h("span", {}, icon("cpu"), step.kind === "parallel" ? `${agent.name} · ${modelLabel(agent.model)}` : modelLabel(agent.model)))),
          step.review ? h("div", { class: "orchestra-loop" }, icon("arrow-clockwise"), `Issues → ${draft.steps.find((entry) => entry.id === step.review?.returnTo)?.name ?? "Choose a step"} · up to ${step.review.maxRounds} revisions`) : null,
          h("div", { class: "orchestra-step-actions" },
            h("button", { class: "icon-button orchestra-drag", type: "button", aria: { label: `Drag ${step.name} to reorder` }, title: "Drag to reorder" }, icon("list-bullets")),
            h("button", { class: "icon-button", type: "button", disabled: index === 0, aria: { label: `Move ${step.name} up` }, onClick: () => move(step.id, -1) }, icon("arrow-up")),
            h("button", { class: "icon-button", type: "button", disabled: index === draft.steps.length - 1, aria: { label: `Move ${step.name} down` }, onClick: () => move(step.id, 1) }, icon("arrow-down"))));
        // Document pointer tracking keeps reordering reliable inside the independently
        // scrolling modal. Arrow buttons provide the same operation by keyboard.
        const handle = card.querySelector<HTMLElement>(".orchestra-drag")!;
        let targetId: string | undefined;
        const clearDrag = () => {
          document.removeEventListener("pointermove", movePointer);
          document.removeEventListener("pointerup", releasePointer);
          document.removeEventListener("pointercancel", clearDrag);
          dragging = undefined; targetId = undefined; card.classList.remove("dragging");
          canvas.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
        };
        handle.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          cancelDrag?.(); event.preventDefault(); dragging = step.id; cancelDrag = clearDrag;
          document.addEventListener("pointermove", movePointer);
          document.addEventListener("pointerup", releasePointer);
          document.addEventListener("pointercancel", clearDrag);
          card.classList.add("dragging");
        });
        const movePointer = (event: PointerEvent) => {
          if (dragging !== step.id) return;
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".orchestra-step");
          canvas.querySelectorAll(".drop-target").forEach((node) => node.classList.remove("drop-target"));
          targetId = target && canvas.contains(target) && target !== card ? target.dataset["stepId"] : undefined;
          if (targetId) target?.classList.add("drop-target");
          const stage = canvas.parentElement;
          if (stage) { const bounds = stage.getBoundingClientRect(); if (event.clientY > bounds.bottom - 32) stage.scrollTop += 12; else if (event.clientY < bounds.top + 32) stage.scrollTop -= 12; }
        };
        const releasePointer = (_event: PointerEvent) => {
          if (dragging !== step.id) return;
          const destination = targetId;
          clearDrag();
          if (!destination) return;
          const from = draft.steps.findIndex((entry) => entry.id === step.id), to = draft.steps.findIndex((entry) => entry.id === destination);
          selected = step.id; move(step.id, to - from); drawInspector();
        };
        return h("div", { class: "orchestra-flow-node" }, card, h("div", { class: "orchestra-connector", aria: { hidden: "true" } }, icon("arrow-down")));
      }),
      h("div", { class: "orchestra-add" }, h("button", { class: "button", type: "button", onClick: () => add("agent") }, icon("plus"), "Agent"), h("button", { class: "button", type: "button", onClick: () => add("parallel") }, icon("stack"), "Run together"), h("button", { class: "button", type: "button", onClick: () => add("approval") }, icon("hand"), "Approval")),
      h("div", { class: "orchestra-finish" }, icon("check-circle"), "Coordinator summarizes → Your conversation"));
  }
  function modelLabel(binding?: AgentModel): string { return binding ? store.get().models.find((entry) => modelKey(entry) === `${binding.providerId}|${binding.runtimeId}|${binding.model}`)?.label ?? binding.model : "Coordinator model"; }
  function modelControl(binding: AgentModel | undefined, change: (model: AgentModel | undefined) => void, inherited: string): HTMLElement {
    const models = store.get().models;
    const key = binding ? `${binding.providerId}|${binding.runtimeId}|${binding.model}` : "inherit";
    const picker = createDropdown({ ariaLabel: "Agent model", placeholder: "Choose a model", menuWidth: 300, onChange: (value: string) => {
      const model = models.find((entry) => modelKey(entry) === value);
      change(model ? { providerId: model.providerId, runtimeId: model.runtimeId, model: model.id } : undefined); drawInspector(); drawCanvas();
    } });
    picker.setOptions([{ value: "inherit", label: inherited }, ...models.map((entry) => ({ value: modelKey(entry), label: entry.label, group: entry.providerName })), ...(binding && !models.some((entry) => modelKey(entry) === key) ? [{ value: key, label: `${binding.model} · unavailable`, disabled: true }] : [])], key);
    const chosen = models.find((entry) => modelKey(entry) === key);
    const wrapper = h("div", { class: "orchestra-model-control" }, field("Model", picker.element));
    if (chosen?.reasoningEfforts?.length) {
      const effort = createDropdown({ ariaLabel: "Reasoning effort", onChange: (value: string) => { if (binding) change(value === "default" ? { providerId: binding.providerId, runtimeId: binding.runtimeId, model: binding.model } : { ...binding, reasoningEffort: value }); } });
      effort.setOptions([{ value: "default", label: "Default" }, ...chosen.reasoningEfforts.map((entry) => ({ value: entry.id, label: entry.id }))], binding?.reasoningEffort ?? "default"); wrapper.append(field("Reasoning", effort.element));
    }
    return wrapper;
  }
  function field(title: string, element: HTMLElement): HTMLElement { return h("label", { class: "orchestra-field" }, h("span", { class: "label" }, title), element); }
  function drawInspector(): void {
    if (selected === "coordinator") {
      replace(inspector, h("span", { class: "label" }, "COORDINATOR"), h("h3", {}, "One conversation. Many hands."), h("p", { class: "note" }, "Workers inherit this model unless you assign their own. The coordinator reads their results and responds in your conversation."), modelControl(draft.coordinator, (model) => { const { coordinator: _, ...rest } = draft; draft = { ...rest, ...(model === undefined ? {} : { coordinator: model }) }; }, "Session model")); return;
    }
    const step = draft.steps.find((entry) => entry.id === selected);
    if (!step) return;
    const current = () => draft.steps.find((entry) => entry.id === selected)!;
    const stepName = h("input", { value: step.name, aria: { label: "Step name" }, onInput: () => setStep({ ...current(), name: stepName.value }) });
    replace(inspector, h("span", { class: "label" }, step.kind === "parallel" ? "PARALLEL GROUP" : step.kind === "approval" ? "APPROVAL POINT" : "AGENT STEP"), field("Step name", stepName));
    if (step.kind === "approval") inspector.append(h("p", { class: "orchestra-callout" }, icon("hand"), "The workflow waits here. You can inspect earlier results, approve the next step, or stop the run."));
    else {
      const updateAgent = (changes: Partial<WorkflowAgent>) => { const now = current(); setStep({ ...now, agents: now.agents.map((agent, index) => index === selectedAgent ? { ...agent, ...changes } : agent) }); };
      const bindAgent = (model?: AgentModel) => { const now = current(); const agent = now.agents[selectedAgent]!; const { model: _, ...rest } = agent; setStep({ ...now, agents: now.agents.map((entry, index) => index === selectedAgent ? { ...rest, ...(model === undefined ? {} : { model }) } : entry) }); };
      if (step.kind === "parallel") inspector.append(h("div", { class: "orchestra-agent-tabs" }, ...step.agents.map((agent, index) => h("button", { class: selectedAgent === index ? "active" : "", type: "button", onClick: () => { selectedAgent = index; drawInspector(); } }, agent.name)), step.agents.length < 4 ? h("button", { type: "button", aria: { label: "Add parallel agent" }, onClick: () => { const agent = agentStep(`Agent ${step.agents.length + 1}`, "Investigate the request and return findings.", "read_only").agents[0]!; setStep({ ...current(), agents: [...current().agents, agent] }); selectedAgent = current().agents.length - 1; drawInspector(); } }, icon("plus")) : null));
      selectedAgent = Math.min(selectedAgent, step.agents.length - 1);
      const agent = step.agents[selectedAgent]!;
      const agentName = h("input", { value: agent.name, aria: { label: "Agent name" }, onInput: () => updateAgent({ name: agentName.value }) });
      inspector.append(field("Agent name", agentName), modelControl(agent.model, bindAgent, "Coordinator model"));
      const access = createDropdown({ ariaLabel: "Agent access", onChange: (value: "read_only" | "inherit") => updateAgent({ access: value }) });
      access.setOptions([{ value: "read_only", label: "Read only" }, { value: "inherit", label: "Session permissions", ...(step.kind === "parallel" ? { disabled: true, description: "Parallel groups are read-only" } : {}) }], agent.access);
      const instructions = h("textarea", { rows: 7, value: agent.instructions, aria: { label: "Agent instructions" }, onInput: () => updateAgent({ instructions: instructions.value }) });
      inspector.append(field("Access", access.element), field("Instructions", instructions), h("div", { class: "orchestra-context-note" }, icon("files"), "Receives your task, recent conversation and completed worker results. Returns its findings to the next step."));
      if (step.kind === "agent") {
        const targets = draft.steps.slice(0, draft.steps.findIndex((entry) => entry.id === step.id)).filter((entry) => entry.kind !== "approval");
        if (targets.length) {
          const review = createDropdown({ ariaLabel: "On review findings", onChange: (value: string) => { const { review: _, ...rest } = current(); setStep({ ...rest, ...(value === "continue" ? {} : { review: { returnTo: value, maxRounds: current().review?.maxRounds ?? 2 } }) }); drawInspector(); } });
          review.setOptions([{ value: "continue", label: "Continue to next step" }, ...targets.map((entry) => ({ value: entry.id, label: `Return to ${entry.name}` }))], step.review?.returnTo ?? "continue");
          inspector.append(h("div", { class: "orchestra-inspector-divider" }), field("If this review finds issues", review.element));
          if (step.review) {
            const rounds = createDropdown({ ariaLabel: "Maximum revision rounds", onChange: (value: string) => setStep({ ...current(), review: { ...current().review!, maxRounds: Number(value) } }) });
            rounds.setOptions([1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: `${value} revision${value === 1 ? "" : "s"}` })), String(step.review.maxRounds)); inspector.append(field("Revision limit", rounds.element));
          }
        }
      }
      if (step.kind === "parallel" && step.agents.length > 2) inspector.append(h("button", { class: "button danger", type: "button", onClick: () => { setStep({ ...current(), agents: current().agents.filter((_, index) => index !== selectedAgent) }); selectedAgent = 0; drawInspector(); } }, "Remove this agent"));
    }
    inspector.append(h("div", { class: "orchestra-inspector-divider" }), h("button", { class: "button orchestra-remove", type: "button", onClick: () => {
      draft = { ...draft, steps: draft.steps.filter((entry) => entry.id !== step.id).map((entry) => { if (entry.review?.returnTo !== step.id) return entry; const { review: _, ...rest } = entry; return rest; }) }; selected = draft.steps[0]?.id ?? "coordinator"; selectedAgent = 0; redraw();
    } }, icon("trash-simple"), "Remove step"));
  }
  function redraw(): void { drawCanvas(); drawInspector(); }
  async function saveDraft(): Promise<void> {
    if (busy) return;
    error.textContent = "";
    try {
      const valid = validateWorkflow(draft); busy = true; save.disabled = true;
      if (await controller.saveWorkflow(valid)) modal.close(); else error.textContent = "Could not save. Check the message in the main window.";
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally { busy = false; save.disabled = false; }
  }
  async function generateDraft(): Promise<void> {
    const sessionId = store.get().selection.sessionId;
    const model = draftingModel;
    if (!sessionId || !model || !prompt.value.trim()) { error.textContent = "Open a conversation, connect a model, and describe the workflow first."; return; }
    if (busy) return; busy = true; generate.disabled = true; save.disabled = true; generate.textContent = "Designing…"; error.textContent = "";
    try {
      const generated = await host.call("orchestra.generate", { sessionId, description: prompt.value.trim(), model });
      draft = { ...generated, id: draft.id, revision: draft.revision, ...(draft.coordinator === undefined ? {} : { coordinator: draft.coordinator }) }; name.value = draft.name; description.value = draft.description; selected = draft.steps[0]!.id; redraw();
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally { busy = false; generate.disabled = false; save.disabled = false; replace(generate, icon("sparkle"), "Generate draft"); }
  }
  redraw();
}
