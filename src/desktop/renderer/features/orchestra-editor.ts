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
import { workflowDraftIssue } from "./orchestra-draft.js";
import { createQuestionRequestsView } from "./user-questions.js";

export function openOrchestraEditor(initial: WorkflowDefinition, store: Store, controller: Controller, host: HostClient): void {
  let draft = structuredClone(initial);
  const originalDraft = JSON.stringify(initial);
  let allowClose = false;
  let discardPromptOpen = false;
  let selected = draft.steps[0]?.id ?? "coordinator";
  let selectedAgent = 0;
  let busy = false;
  let generation: { id: string; cancelling: boolean } | undefined;
  let dragging: string | undefined;
  let cancelDrag: (() => void) | undefined;
  const canvas = h("div", { class: "orchestra-canvas", aria: { label: "Workflow steps" } });
  const inspector = h("aside", { class: "orchestra-inspector", aria: { label: "Step settings" } });
  const error = h("p", { class: "error-line", role: "alert" });
  const name = h("input", { class: "orchestra-name", value: draft.name, aria: { label: "Workflow name" }, onInput: () => { draft = { ...draft, name: name.value }; } });
  const description = h("input", { class: "orchestra-description", value: draft.description, placeholder: "What does this workflow do?", aria: { label: "Workflow description" }, onInput: () => { draft = { ...draft, description: description.value }; } });
  const prompt = h("textarea", { rows: 2, placeholder: "Describe your workflow. Who should work, in what order, and when should they ask you?", aria: { label: "Describe a workflow" } });
  const generate = h("button", { class: "button", type: "button", onClick: () => void generateDraft() }, icon("sparkle"), "Generate draft");
  let availableModels = store.get().models;
  const firstDraftModel = availableModels.find((model) => store.get().favoriteModelKeys.includes(modelKey(model))) ?? availableModels[0];
  let draftingModel: AgentModel | undefined = draft.coordinator ?? (firstDraftModel ? { providerId: firstDraftModel.providerId, runtimeId: firstDraftModel.runtimeId, model: firstDraftModel.id } : undefined);
  const draftingPicker = createDropdown({ ariaLabel: "Workflow drafting model", variant: "pill", placeholder: "Connect a model to generate", onChange: (key: string) => {
    const model = availableModels.find((entry) => modelKey(entry) === key);
    draftingModel = model ? { providerId: model.providerId, runtimeId: model.runtimeId, model: model.id } : undefined;
    refreshDraftingModels();
  } });
  const draftingStatus = h("p", { class: "note", role: "status" });
  const generationStatus = h("p", { class: "orchestra-generation-status", role: "status", aria: { atomic: "true" } });
  const cancelGenerationButton = h("button", { class: "button", type: "button", onClick: () => void cancelGeneration() }, "Cancel generation");
  cancelGenerationButton.hidden = true;
  const designerQuestions = createQuestionRequestsView(store, controller, (runId, state) => !!generation && state.orchestra.generations?.some((entry) => entry.id === generation!.id && entry.executionId === runId) === true);
  designerQuestions.element.setAttribute("aria-label", "Questions from the workflow designer");
  const answerDesigner = h("button", { class: "button button-small", type: "button", onClick: () => {
    const target = designerQuestions.element.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled)");
    target?.focus(); target?.scrollIntoView({ block: "nearest" });
  } }, "Answer designer");
  answerDesigner.hidden = true;
  // This region is outside the collapsible description. Cancellation and input
  // remain reachable even when the user folds the generation settings away.
  const generationNotice = h("section", { class: "orchestra-generation-notice", aria: { label: "Workflow drafting" } },
    h("div", { class: "orchestra-generation-copy" }, generationStatus,
      h("p", { class: "note" }, "Your existing draft is kept until a replacement is ready.")),
    h("div", { class: "orchestra-generation-controls" }, answerDesigner, cancelGenerationButton));
  generationNotice.hidden = true;
  const save = h("button", { class: "button button-primary", type: "button", onClick: () => void saveDraft() }, icon("floppy-disk"), "Save workflow");
  const content = h("div", { class: "orchestra-studio" },
    h("header", { class: "orchestra-studio-heading" }, h("div", {}, h("span", { class: "label" }, "WORKFLOW"), name, description)),
    h("div", { class: "orchestra-studio-body" }, h("div", { class: "orchestra-stage" },
      h("details", { class: "orchestra-generate" }, h("summary", {}, icon("sparkle"), "Generate from a description", icon("caret-down")), h("div", {}, prompt, h("p", { class: "orchestra-generate-note" }, "Uses the model below to generate an editable draft. Review the steps before saving."), h("div", { class: "orchestra-draft-actions" }, draftingPicker.element, generate), draftingStatus)),
      generationNotice,
      designerQuestions.element,
      h("div", { class: "orchestra-templates" }, h("span", {}, "Templates"), h("button", { class: "orchestra-template", type: "button", onClick: () => confirmReplace(() => {
        draft = { ...draft, name: "Untitled workflow", description: "", steps: [] }; name.value = draft.name; description.value = draft.description; selected = "coordinator"; selectedAgent = 0; redraw();
      }) }, "Blank"), ...([['feature', 'Feature'], ['review', 'Review'], ['research', 'Research']] as const).map(([kind, title]) => h("button", { class: "orchestra-template", type: "button", onClick: () => confirmReplace(() => {
        draft = { ...workflowTemplate(kind), id: draft.id, revision: draft.revision, ...(draft.coordinator === undefined ? {} : { coordinator: draft.coordinator }) }; name.value = draft.name; description.value = draft.description; selected = draft.steps[0]!.id; selectedAgent = 0; redraw();
      }) }, title))), canvas), inspector),
    h("footer", { class: "orchestra-studio-footer" }, h("div", {}, error, h("span", { class: "note" }, "Saved changes apply to future runs. Active runs keep their original version.")),
      h("button", { class: "button", type: "button", onClick: () => modal.close() }, "Cancel"), save));
  const modal = openModal({ title: "Workflow studio", className: "orchestra-modal", content, beforeClose: () => {
    if (allowClose) return true;
    if (generation) { void cancelGeneration(); return false; }
    if (busy) { error.textContent = "Wait for the current request to finish before closing."; return false; }
    if (JSON.stringify(draft) === originalDraft) return true;
    confirmReplace(() => { allowClose = true; modal.close(); }); return false;
  }, onClose: () => { cancelDrag?.(); stopCatalogWatch(); stopGenerationWatch(); designerQuestions.dispose(); } });

  /** Announce lifecycle changes without replacing question forms or moving
   * focus while the user is typing. The explicit answer link reveals input. */
  function refreshGenerationStatus(): void {
    if (!generation) return;
    const state = store.get();
    const executionId = state.orchestra.generations?.find((entry) => entry.id === generation!.id)?.executionId;
    const needsAnswer = !!executionId && (state.live[executionId]?.pendingQuestions?.length ?? 0) > 0;
    const message = generation.cancelling ? "Cancelling draft generation…" : needsAnswer ? "Workflow designer needs your answer" : "Designing your workflow…";
    // Streaming updates should not reannounce an unchanged lifecycle message.
    if (generationStatus.textContent !== message) generationStatus.textContent = message;
    answerDesigner.hidden = !needsAnswer || generation.cancelling;
  }
  const stopGenerationWatch = store.watch((state) => [state.orchestra.generations, state.live], () => refreshGenerationStatus());

  /** Catalog updates never replace an assigned model or the local draft. A
   * model may arrive after opening the editor; an unavailable explicit choice
   * remains visible until the user deliberately chooses its replacement. */
  function refreshDraftingModels(): void {
    const state = store.get();
    const catalogChanged = availableModels !== state.models;
    availableModels = state.models;
    if (!draftingModel) {
      const first = availableModels.find((entry) => state.favoriteModelKeys.includes(modelKey(entry))) ?? availableModels[0];
      if (first) draftingModel = { providerId: first.providerId, runtimeId: first.runtimeId, model: first.id };
    }
    const key = draftingModel ? `${draftingModel.providerId}|${draftingModel.runtimeId}|${draftingModel.model}` : undefined;
    const unavailable = !!key && !availableModels.some((entry) => modelKey(entry) === key);
    // Close a menu holding old catalog entries before updating its options.
    // Focus returns to its trigger; no draft fields or question nodes rebuild.
    const hadFocus = catalogChanged && draftingPicker.element.getAttribute("aria-expanded") === "true";
    if (catalogChanged) draftingPicker.setDisabled(true);
    draftingPicker.setOptions([...availableModels.map((entry) => ({ value: modelKey(entry), label: entry.label, group: entry.providerName })), ...(unavailable ? [{ value: key!, label: `${draftingModel!.model} · unavailable`, disabled: true }] : [])], key);
    draftingPicker.setDisabled(busy || availableModels.length === 0);
    generate.disabled = busy || !key || unavailable;
    draftingStatus.textContent = unavailable ? "The selected drafting model is unavailable. Choose a connected model to generate." : !key ? state.modelsLoading ? "Discovering models…" : "Connect a model to generate a draft." : "";
    draftingStatus.hidden = !draftingStatus.textContent;
    if (hadFocus && !busy) draftingPicker.element.focus();
  }
  const stopCatalogWatch = store.watch((state) => [state.models, state.modelsLoading, state.favoriteModelKeys], () => refreshDraftingModels());

  /** All destructive draft replacement paths share the same guard. Save
   * failures/conflicts keep the exact local draft in this editor. */
  function confirmReplace(action: () => void): void {
    if (busy || discardPromptOpen) return;
    if (JSON.stringify(draft) === originalDraft) { action(); return; }
    discardPromptOpen = true;
    const confirmation = openModal({ title: "Discard unsaved workflow changes?", content: h("div", { class: "modal-body" },
      h("p", {}, "Your current workflow draft has unsaved changes."),
      h("button", { class: "button", type: "button", onClick: () => confirmation.close() }, "Keep editing"),
      h("button", { class: "button button-primary", type: "button", onClick: () => { confirmation.close(); action(); } }, "Discard changes")),
      onClose: () => { discardPromptOpen = false; } });
  }

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
    const focused = canvas.contains(document.activeElement) ? document.activeElement as HTMLElement : undefined;
    const focusLabel = focused?.getAttribute("aria-label");
    const focusStep = focused?.closest<HTMLElement>("[data-step-id]")?.dataset.stepId;
    replace(canvas,
      h("button", { class: `orchestra-conductor ${selected === "coordinator" ? "selected" : ""}`, type: "button", aria: { pressed: String(selected === "coordinator") }, onClick: () => choose("coordinator") }, icon("flow-arrow"), h("span", {}, h("strong", {}, "Coordinator"), h("small", {}, "Brings the results back to your conversation")), h("span", { class: "orchestra-model-label" }, draft.coordinator ? modelLabel(draft.coordinator) : "Uses session model")),
      h("div", { class: "orchestra-flow-label" }, h("span", { class: "label" }, "STEPS · RUN IN ORDER"), h("span", {}, `${draft.steps.length} steps`)),
      ...draft.steps.map((step, index) => {
        const select = h("button", { class: "orchestra-step-main", type: "button", aria: { pressed: String(selected === step.id) }, onClick: () => choose(step.id) },
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
    if (focused) {
      const control = [...canvas.querySelectorAll<HTMLButtonElement>("button")].find((node) => focusLabel && node.getAttribute("aria-label") === focusLabel && !node.disabled);
      const card = [...canvas.querySelectorAll<HTMLElement>("[data-step-id]")].find((node) => node.dataset.stepId === focusStep)?.querySelector<HTMLElement>(".orchestra-step-main");
      (control ?? card ?? canvas.querySelector<HTMLElement>(".orchestra-conductor"))?.focus({ preventScroll: true });
    }
  }
  function modelLabel(binding?: AgentModel): string { return binding ? store.get().models.find((entry) => modelKey(entry) === `${binding.providerId}|${binding.runtimeId}|${binding.model}`)?.label ?? binding.model : "Uses coordinator model"; }
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
    wrapper.append(h("p", { class: "orchestra-model-inheritance" }, binding
      ? chosen ? `Assigned to ${chosen.label}. Saved changes affect future runs.` : `${binding.model} is unavailable. Choose a connected model before running.`
      : inherited === "Uses session model" ? "Resolved from the conversation model when the workflow starts."
      : draft.coordinator ? `Inherits ${modelLabel(draft.coordinator)} from the coordinator.` : "Inherits the coordinator’s model, resolved from the conversation at run start."));
    if (chosen?.reasoningEfforts?.length) {
      const effort = createDropdown({ ariaLabel: "Reasoning effort", onChange: (value: string) => { if (binding) change(value === "default" ? { providerId: binding.providerId, runtimeId: binding.runtimeId, model: binding.model } : { ...binding, reasoningEffort: value }); } });
      effort.setOptions([{ value: "default", label: "Default" }, ...chosen.reasoningEfforts.map((entry) => ({ value: entry.id, label: entry.id }))], binding?.reasoningEffort ?? "default"); wrapper.append(field("Reasoning", effort.element));
    }
    return wrapper;
  }
  function field(title: string, element: HTMLElement): HTMLElement { return h("label", { class: "orchestra-field" }, h("span", { class: "label" }, title), element); }
  function drawInspector(): void {
    if (selected === "coordinator") {
      replace(inspector, h("span", { class: "label" }, "COORDINATOR"), h("h3", {}, "Coordinator model"), h("p", { class: "note" }, "Workers inherit this model unless you assign their own. The coordinator reads their results and responds in your conversation."), modelControl(draft.coordinator, (model) => { const { coordinator: _, ...rest } = draft; draft = { ...rest, ...(model === undefined ? {} : { coordinator: model }) }; }, "Uses session model")); return;
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
      if (step.kind === "parallel") inspector.append(h("div", { class: "orchestra-agent-tabs" }, ...step.agents.map((agent, index) => h("button", { class: selectedAgent === index ? "active" : "", type: "button", aria: { pressed: String(selectedAgent === index) }, onClick: () => { selectedAgent = index; drawInspector(); } }, agent.name)), step.agents.length < 4 ? h("button", { type: "button", aria: { label: "Add parallel agent" }, onClick: () => { const agent = agentStep(`Agent ${step.agents.length + 1}`, "Investigate the request and return findings.", "read_only").agents[0]!; setStep({ ...current(), agents: [...current().agents, agent] }); selectedAgent = current().agents.length - 1; drawInspector(); } }, icon("plus")) : null));
      selectedAgent = Math.min(selectedAgent, step.agents.length - 1);
      const agent = step.agents[selectedAgent]!;
      const agentName = h("input", { value: agent.name, aria: { label: "Agent name" }, onInput: () => updateAgent({ name: agentName.value }) });
      inspector.append(field("Agent name", agentName), modelControl(agent.model, bindAgent, "Uses coordinator model"));
      const access = createDropdown({ ariaLabel: "Agent access", onChange: (value: "read_only" | "inherit") => updateAgent({ access: value }) });
      access.setOptions([{ value: "read_only", label: "Read only" }, { value: "inherit", label: "Session permissions", ...(step.kind === "parallel" ? { disabled: true, description: "Parallel groups are read-only" } : {}) }], agent.access);
      const instructions = h("textarea", { rows: 7, value: agent.instructions, aria: { label: "Agent instructions" }, onInput: () => updateAgent({ instructions: instructions.value }) });
      inspector.append(field("Access", access.element), field("Instructions", instructions), h("div", { class: "orchestra-context-note" }, icon("files"), "Receives your task, recent conversation and completed worker results. Returns its findings to the next step."));
      if (step.kind === "agent") {
        const targets = draft.steps.slice(0, draft.steps.findIndex((entry) => entry.id === step.id)).filter((entry) => entry.kind !== "approval");
        if (targets.length || step.review) {
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
  function lockControls(): () => void {
    const controls = [...content.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button")].filter((node) => node !== cancelGenerationButton && node !== answerDesigner).map((node) => ({ node, disabled: node.disabled }));
    controls.forEach(({ node }) => { node.disabled = true; });
    return () => controls.forEach(({ node, disabled }) => { node.disabled = disabled; });
  }
  async function saveDraft(): Promise<void> {
    if (busy) return;
    let unlock: (() => void) | undefined;
    error.textContent = "";
    content.querySelectorAll("[aria-invalid]").forEach((node) => node.removeAttribute("aria-invalid"));
    try {
      const issue = workflowDraftIssue(draft);
      if (issue) {
        error.textContent = issue.message;
        if (issue.stepId) { selected = issue.stepId; selectedAgent = issue.agentIndex ?? 0; redraw(); }
        const target = [...content.querySelectorAll<HTMLElement>("[aria-label]")].find((node) => node.getAttribute("aria-label") === issue.field);
        target?.setAttribute("aria-invalid", "true"); target?.focus();
        return;
      }
      const valid = validateWorkflow(draft); busy = true; save.disabled = true;
      unlock = lockControls();
      if (await controller.saveWorkflow(valid)) { allowClose = true; modal.close(); } else error.textContent = "Could not save. Your draft is retained. Check the message in the main window.";
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally { unlock?.(); busy = false; save.disabled = false; refreshDraftingModels(); }
  }
  async function generateDraft(): Promise<void> {
    confirmReplace(() => void performGeneration());
  }
  async function performGeneration(): Promise<void> {
    const sessionId = store.get().selection.sessionId;
    const model = draftingModel;
    if (!sessionId || !model || !prompt.value.trim()) { error.textContent = "Open a conversation, connect a model, and describe the workflow first."; return; }
    if (!availableModels.some((entry) => modelKey(entry) === `${model.providerId}|${model.runtimeId}|${model.model}`)) { error.textContent = "The selected drafting model is unavailable. Choose a connected model."; return; }
    if (busy) return; busy = true; generate.disabled = true; save.disabled = true; generate.textContent = "Designing…"; error.textContent = "";
    const request = generation = { id: crypto.randomUUID(), cancelling: false };
    generationNotice.hidden = false; cancelGenerationButton.hidden = false; refreshGenerationStatus();
    const unlock = lockControls();
    // Disabling Generate otherwise leaves keyboard focus on the document body.
    cancelGenerationButton.focus();
    try {
      const generated = await host.call("orchestra.generate", { sessionId, description: prompt.value.trim(), model, generationId: request.id });
      if (request.cancelling) return;
      draft = { ...generated, id: draft.id, revision: draft.revision, ...(draft.coordinator === undefined ? {} : { coordinator: draft.coordinator }) }; name.value = draft.name; description.value = draft.description; selected = draft.steps[0]!.id; redraw();
    } catch (failure) { if (!request.cancelling) error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally {
      const restoreFocus = document.activeElement === document.body || generationNotice.contains(document.activeElement) || designerQuestions.element.contains(document.activeElement);
      generationStatus.textContent = request.cancelling ? "Draft generation cancelled. Your existing draft is retained." : error.textContent ? "Draft generation failed. Your existing draft is retained." : "Draft ready. Review the steps before saving.";
      unlock(); busy = false; generation = undefined; answerDesigner.hidden = true; cancelGenerationButton.hidden = true; cancelGenerationButton.disabled = false; save.disabled = false; replace(generate, icon("sparkle"), "Generate draft"); refreshDraftingModels();
      if (restoreFocus) { generate.closest("details")!.open = true; generate.focus(); }
    }
  }
  /** Cancel keeps the editor/draft open. The host only resolves generation
   * after the designer and its pending question broker have settled. */
  async function cancelGeneration(): Promise<void> {
    const request = generation;
    if (!request || request.cancelling) return;
    request.cancelling = true; cancelGenerationButton.disabled = true;
    error.textContent = "";
    refreshGenerationStatus();
    try { await host.call("orchestra.cancelGeneration", { generationId: request.id }); }
    catch (failure) {
      if (generation !== request) return;
      request.cancelling = false; cancelGenerationButton.disabled = false;
      refreshGenerationStatus();
      error.textContent = `Could not cancel generation. Try again. ${failure instanceof Error ? failure.message : String(failure)}`;
    }
  }
  redraw();
}
