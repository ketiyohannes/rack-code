import { sessionWorkerRunIds, sessionGenerationRunIds } from "./orchestra-state.js";
/** Persistent question forms above the composer. Streaming updates and
 * session switches retain drafts/focus; only host-owned pending requests
 * can be answered, and resolved requests release their DOM and draft text.
 */
import type { UserQuestionRequest, UserQuestionResponse } from "@rack/contracts/views";
import type { Controller } from "../controller.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";
import type { AppState, Store } from "../store.js";

export function createQuestionRequests(store: Store, controller: Controller): HTMLElement {
  return createQuestionRequestsView(store, controller).element;
}

/** A scoped question region for temporary views such as workflow drafting.
 * The same broker-owned form is used everywhere; disposing releases its watch. */
export function createQuestionRequestsView(store: Store, controller: Controller, visibleRun?: (runId: string, state: AppState) => boolean): { element: HTMLElement; dispose: () => void } {
  const region = h("div", { class: "question-requests", role: "region", aria: { label: "Questions from the agent", live: "polite" } });
  const cards = new Map<string, HTMLElement>();
  const dispose = store.watch((state) => [state.live, state.orchestra, state.selection.sessionId], (_slice, state) => {
    const pending = Object.values(state.live).flatMap((live) => (live.pendingQuestions ?? []).map((request) => ({ run: live.run, request })));
    const all = new Set(pending.map(({ run, request }) => `${run.id}:${request.id}`));
    const visible = pending.filter(({ run }) => visibleRun ? visibleRun(run.id, state) : run.sessionId === state.selection.sessionId || sessionWorkerRunIds(state).has(run.id) || sessionGenerationRunIds(state).has(run.id));
    const visibleKeys = new Set(visible.map(({ run, request }) => `${run.id}:${request.id}`));
    for (const [key, card] of cards) {
      if (!visibleKeys.has(key)) card.remove();
      if (!all.has(key)) {
        card.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.value = ""; });
        cards.delete(key);
      }
    }
    for (const { run, request } of visible) {
      const key = `${run.id}:${request.id}`;
      let card = cards.get(key);
      if (card === undefined) { card = questionCard(run.id, request, controller); cards.set(key, card); }
      if (card.parentElement !== region) region.append(card);
    }
    region.hidden = visible.length === 0;
  });
  return { element: region, dispose };
}

function questionCard(runId: string, request: UserQuestionRequest, controller: Controller): HTMLElement {
  const fields: { id: string; text: string; checks: HTMLInputElement[]; custom?: HTMLInputElement }[] = [];
  const error = h("p", { class: "question-error", role: "alert" });
  const submit = h("button", { class: "button button-primary button-small", type: "button", onClick: () => void answer(false) }, "Submit answers");
  const dismiss = h("button", { class: "button button-small", type: "button", onClick: () => void answer(true) }, "Dismiss");
  const card = h("section", { class: "question-card", data: { pendingRequest: request.id, executionId: runId }, role: "group", aria: { label: "Answer the agent's questions" },
    onKeydown: (event) => {
      // Enter inside an answer field must never submit the outer composer
      // form (whose submit action can stop an active run).
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) { event.preventDefault(); event.stopPropagation(); }
    } },
    h("div", { class: "question-card-heading" }, icon("question"), h("strong", {}, request.questions.length === 1 ? "The agent has a question" : "The agent has questions")),
    ...request.questions.map((question) => {
      const checks: HTMLInputElement[] = [];
      const custom = question.allowCustom ? h("input", { class: "question-custom", type: question.isSecret ? "password" : "text",
        placeholder: question.options.length === 0 ? "Type your answer" : "Or type your own answer",
        aria: { label: `Answer: ${question.question}` } }) : undefined;
      if (custom !== undefined) {
        custom.autocomplete = "off";
        custom.maxLength = 10_000;
        custom.addEventListener("input", () => { if (!question.multiSelect && custom.value !== "") checks.forEach((input) => { input.checked = false; }); });
      }
      fields.push({ id: question.id, text: question.question, checks, ...(custom === undefined ? {} : { custom }) });
      return h("fieldset", { class: "question-field" },
        h("legend", {}, question.header === undefined ? question.question : `${question.header}: ${question.question}`),
        question.multiSelect ? h("p", { class: "question-hint" }, "Select all that apply.") : null,
        ...question.options.map((option) => {
          const input = h("input", { type: question.multiSelect ? "checkbox" : "radio", name: `${request.id}:${question.id}`, value: option.label,
            onChange: () => { if (!question.multiSelect && custom !== undefined) custom.value = ""; } });
          checks.push(input);
          return h("label", { class: "question-option" }, input, h("span", {}, h("span", { class: "question-option-label" }, option.label),
            option.description === undefined ? null : h("span", { class: "question-option-description" }, option.description)));
        }), custom,
      );
    }),
    error, h("div", { class: "question-actions" }, dismiss, submit));

  async function answer(cancel: boolean): Promise<void> {
    let response: UserQuestionResponse | null = null;
    if (!cancel) {
      const answers = fields.map((field) => {
        const selected = field.checks.filter((input) => input.checked).map((input) => input.value);
        if (field.custom?.value.trim() && !selected.includes(field.custom.value)) selected.push(field.custom.value);
        return [field.id, selected] as const;
      });
      const missing = answers.find((entry) => entry[1].length === 0);
      if (missing !== undefined) { error.textContent = `Choose or enter an answer for: ${fields.find((field) => field.id === missing[0])!.text}`; return; }
      response = { answers: Object.fromEntries(answers) };
    }
    error.textContent = "";
    submit.disabled = dismiss.disabled = true;
    card.querySelectorAll<HTMLFieldSetElement>("fieldset").forEach((field) => { field.disabled = true; });
    const accepted = await controller.respondToQuestions(runId, request.id, response);
    if (!accepted) {
      submit.disabled = dismiss.disabled = false;
      card.querySelectorAll<HTMLFieldSetElement>("fieldset").forEach((field) => { field.disabled = false; });
      error.textContent = "Could not send these answers. Check the connection and try again.";
    }
  }
  return card;
}
