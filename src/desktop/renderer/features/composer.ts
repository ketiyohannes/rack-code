import { createSkillsPicker } from "./skills-picker.js";
/**
 * Run composer. Provider runtimes are implementation details: the only
 * provider-facing choice is a model from the unified catalog. The selected
 * model carries hidden runtime/provider routing metadata to the host.
 *
 * Pending approvals are rendered above the prompt so they remain actionable
 * without becoming chat messages. The host owns the pending state, which
 * means a reconnecting renderer can answer an approval just like the original.
 */
import {
  type AccountView,
  type ApprovalRequest,
  type ModelView,
  type PermissionMode,
  type RunView,
  type RuntimeCapabilities,
} from "../../../contracts/desktop/index.js";
import { createDropdown, type DropdownOption } from "../components/dropdown.js";
import { createModelPicker } from "../components/model-picker.js";
import type { Controller } from "../controller.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import type { AppState, LiveRun, Store } from "../store.js";
import { accountLabel, isActiveStatus, PERMISSION_LABELS } from "./run-format.js";
import { presentTool } from "./tool-presentation.js";
import { createAttachmentPicker } from "./attachments.js";
import { modelKey } from "../components/model-settings.js";
import { createQuestionRequests } from "./user-questions.js";

type AccountChoice = `auto:${string}` | `account:${string}:${string}`;

const MODE_ICONS: Readonly<Record<PermissionMode, Parameters<typeof icon>[0]>> = {
  read_only: "lock-simple", ask: "hand", approve_for_me: "shield-check", full_access: "lightning",
};

export function mountComposer(root: HTMLElement, store: Store, controller: Controller): void {
  let mode: PermissionMode = "approve_for_me";
  let submitting = false;
  let workflow: "normal" | "plan" = "normal";
  let draftSession: string | undefined;
  let workflowInitializedFor: string | undefined;
  const drafts = new Map<string, { prompt: string; workflow: "normal" | "plan" }>();
  const skills = createSkillsPicker(controller, () => refresh(store.get()));
  const planToggle = h("button", { class: "icon-button composer-action plan-toggle", type: "button", aria: { label: "Plan mode", pressed: "false" }, title: "Research and plan before implementing", onClick: () => { workflow = workflow === "plan" ? "normal" : "plan"; refresh(store.get()); } }, icon("list-checks"));
  const planCard = h("div", { class: "plan-ready", role: "region", aria: { label: "Plan ready for review" } });
  const attachments = createAttachmentPicker(controller, () => refresh(store.get()));

  const permission = createDropdown<PermissionMode>({
    ariaLabel: "Permission mode", variant: "pill", iconOnly: true, icon: "shield", menuWidth: 200,
    onChange: (value) => { mode = value; refresh(store.get()); },
  });
  const account = createDropdown<AccountChoice>({
    ariaLabel: "Account", variant: "pill", iconOnly: true, icon: "user", placeholder: "No accounts", menuWidth: 280,
    formatValue: (option) => option.label.toLowerCase() === "auto" ? "Auto" : option.label,
    onChange: () => refresh(store.get()),
  });
  const model = createModelPicker(() => refresh(store.get()), () => controller.openSettings("models"));

  const connectPill = h("button", {
    class: "icon-button composer-action", type: "button", title: "Connect an account", aria: { label: "Connect an account" },
    onClick: () => controller.openSettings("accounts"),
  }, icon("plugs"));

  const prompt = h("textarea", {
    class: "prompt-input", rows: 1, placeholder: "Ask the agent to do something", aria: { label: "Prompt" },
  });
  const send = h("button", { class: "send-button", type: "submit" });
  const guard = h("div", { class: "guard" });
  const form = h("form", { class: "composer", onSubmit: (event) => {
    event.preventDefault();
    void submitOrStop();
  } },
    // Requests and notices share one bounded stack above the prompt. They
    // must never consume its fixed height or hide the send/stop control.
    h("div", { class: "composer-overlays" }, createQuestionRequests(store, controller), guard, planCard),
    h("div", { class: "composer-card" },
      attachments.list,
      skills.chips,
      prompt,
      h("div", { class: "composer-toolbar" },
        attachments.trigger,
        h("div", { class: "composer-pills" }, planToggle, permission.element, skills.trigger, account.element, connectPill, model.element),
        send,
      ),
    ),
  );
  root.append(form);

  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitOrStop();
    }
  });
  prompt.addEventListener("input", () => { refresh(store.get()); });
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "/" && prompt.value === "" && !event.ctrlKey && !event.metaKey && !skills.trigger.disabled) { event.preventDefault(); skills.open(); }
  });

  // Bubble-phase handling lets menus and dialogs consume Escape first. It
  // stops only this session's active run and never clears the draft prompt.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.repeat || event.isComposing || event.defaultPrevented) return;
    if (document.querySelector(".popover, .modal-backdrop, .settings-overlay:not([hidden])") !== null) return;
    const state = store.get();
    const active = activeRunId(state);
    if (active === undefined || state.live[active]?.cancelRequested) return;
    event.preventDefault();
    void controller.cancelRun(active);
  });

  function activeRunId(state: AppState): string | undefined {
    // Navigation selects the new ID before its record finishes loading.
    // During that interval the previous session's run must not be actionable.
    if (state.selection.sessionId !== state.session?.id) return undefined;
    return Object.values(state.live).find((live) => live.run.sessionId === state.session?.id && isActiveStatus(live.run.status))?.run.id;
  }

  async function submitOrStop(approvedPlanRunId?: string): Promise<void> {
    const state = store.get();
    const active = activeRunId(state);
    if (active !== undefined) {
      if (!state.live[active]?.cancelRequested) await controller.cancelRun(active);
      return;
    }
    const session = state.session;
    const selected = model.selected;
    const choice = parseChoice(account.value);
    const text = prompt.value.trim();
    const draft = session === undefined ? [] : attachments.files(session.id);
    const rawPrompt = prompt.value;
    if (submitting || attachments.busy || session === undefined || selected === undefined || choice === undefined || (text === "" && draft.length === 0 && !approvedPlanRunId) || !canRun(state)) return;
    submitting = true;
    refresh(state);
    const reasoningEffort = model.reasoningEffort;
    const chosenSpeed = model.speed;
    const ok = await controller.startRun({
      sessionId: session.id, ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
      runtimeId: selected.runtimeId, providerId: selected.providerId,
      ...(choice.accountId === undefined ? {} : { accountId: choice.accountId }),
      ...(selected.id === "default" ? {} : { model: selected.id }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(chosenSpeed === undefined ? {} : { speed: chosenSpeed }),
      prompt: text, permissionMode: mode, interactionMode: approvedPlanRunId ? "normal" : workflow,
      ...(approvedPlanRunId ? { approvedPlanRunId } : {}),
      ...(skills.ids().length ? { skillIds: skills.ids() } : {}),
      ...(draft.length === 0 ? {} : { attachmentIds: draft.map((file) => file.id) }),
    });
    submitting = false;
    if (ok) {
      attachments.clear(session.id, draft.map((file) => file.id));
      if (store.get().session?.id === session.id && prompt.value === rawPrompt) { prompt.value = ""; prompt.scrollTop = 0; }
    }
    refresh(store.get());
  }

  function unacknowledgedUnknown(state: AppState): string | undefined {
    const last = state.runs.at(-1);
    return last?.status === "unknown" && state.acknowledgedUnknown[last.id] === undefined ? last.id : undefined;
  }

  function canRun(state: AppState): boolean {
    const selected = model.selected;
    // Settings updates synchronously, while DOM watchers run next frame. Check
    // the current preference here too, so an unstarred model cannot be sent
    // through a stale picker during that interval.
    return state.session !== undefined && state.selection.sessionId === state.session.id && state.host.status === "ready" && selected !== undefined && state.favoriteModelKeys.includes(modelKey(selected)) &&
      account.value !== undefined && unacknowledgedUnknown(state) === undefined && !modeDisabled(capabilitiesFor(state));
  }

  function selectedModel(): ModelView | undefined {
    return model.selected;
  }

  function effectiveAccount(state: AppState): AccountView | undefined {
    const selected = selectedModel();
    const choice = parseChoice(account.value);
    if (selected === undefined || choice === undefined) return undefined;
    return choice.accountId === undefined
      ? state.accounts.find((entry) => entry.providerId === selected.providerId && entry.selected)
      : state.accounts.find((entry) => entry.id === choice.accountId && entry.providerId === selected.providerId);
  }

  function capabilitiesFor(state: AppState): RuntimeCapabilities | undefined {
    const selected = selectedModel();
    const target = effectiveAccount(state);
    if (selected === undefined || target === undefined) return undefined;
    const key = `${selected.runtimeId}|${target.id}`;
    const caps = state.capabilities[key];
    if (caps === undefined) void controller.loadCapabilities(selected.runtimeId, target.id);
    return caps;
  }

  function modeDisabled(caps: RuntimeCapabilities | undefined): boolean {
    return caps !== undefined && !caps.approvals && (mode === "ask" || mode === "approve_for_me");
  }

  function refresh(state: AppState): void {
    if (draftSession !== state.selection.sessionId) {
      if (draftSession && workflowInitializedFor === draftSession) drafts.set(draftSession, { prompt: prompt.value, workflow });
      draftSession = state.selection.sessionId;
      const draft = draftSession ? drafts.get(draftSession) : undefined;
      prompt.value = draft?.prompt ?? "";
      workflow = draft?.workflow ?? "normal";
      workflowInitializedFor = draft ? draftSession : undefined;
      prompt.scrollTop = 0;
    }
    // Session metadata/history arrive after selection. Restore the persisted
    // workflow only once they belong to this chat, without overwriting a draft.
    if (draftSession && workflowInitializedFor !== draftSession && state.session?.id === draftSession) {
      workflow = state.runs.at(-1)?.interactionMode ?? "normal";
      workflowInitializedFor = draftSession;
    }
    const activeId = activeRunId(state);
    if (activeId !== undefined) { mode = state.live[activeId]!.run.permissionMode; workflow = state.live[activeId]!.run.interactionMode ?? "normal"; }
    model.update(state.models, state.favoriteModelKeys);
    const selected = selectedModel();
    const targetProvider = selected?.providerId;
    const accounts = targetProvider === undefined ? [] : state.accounts.filter((entry) => entry.providerId === targetProvider);
    const accountOptions: DropdownOption<AccountChoice>[] = targetProvider === undefined || accounts.length === 0 ? [] : [
      {
        value: `auto:${targetProvider}` as AccountChoice, label: "Auto",
        description: accounts.find((entry) => entry.selected) === undefined
          ? "The host chooses an available account"
          : `Selected: ${accountLabel(accounts.find((entry) => entry.selected))}, with fallback if unavailable`,
        icon: "sliders-horizontal", group: selected?.providerName ?? "",
      },
      ...accounts.map((entry): DropdownOption<AccountChoice> => ({
        value: `account:${targetProvider}:${entry.id}`, label: accountLabel(entry),
        description: entry.availability.replace("_", " "), icon: "user-circle", group: selected?.providerName ?? "",
      })),
    ];
    account.element.hidden = accountOptions.length === 0;
    connectPill.hidden = accountOptions.length > 0 || (selected === undefined && state.accounts.length > 0);
    const currentAccount = account.value;
    const accountStillValid = currentAccount !== undefined && accountOptions.some((option) => option.value === currentAccount);
    account.setOptions(accountOptions, accountStillValid ? currentAccount : (targetProvider === undefined ? undefined : `auto:${targetProvider}`));

    const caps = capabilitiesFor(state);
    permission.setOptions((["ask", "approve_for_me", "full_access", "read_only"] as const).map((candidate) => {
      const unavailable = caps !== undefined && !caps.approvals && (candidate === "ask" || candidate === "approve_for_me");
      return {
        value: candidate, label: PERMISSION_LABELS[candidate].label, icon: MODE_ICONS[candidate], disabled: unavailable,
      };
    }), mode);

    const unknownRunId = unacknowledgedUnknown(state);
    const approvals = pendingApprovals(state);
    const catalogMessage = state.session === undefined ? undefined : modelCatalogMessage(state);
    const needsFavorites = state.models.length > 0 && selected === undefined;
    replace(guard,
      ...approvals.map(({ run, live, request }) => renderApproval(request, run, live, state, controller)),
      ...(catalogMessage === undefined ? [] : [
        h("div", { class: "guard-warning catalog-warning" }, icon("info"), h("span", {}, catalogMessage)),
      ]),
      ...(needsFavorites ? [h("div", { class: "guard-warning" }, icon("star"),
        h("span", {}, state.favoriteModelKeys.length === 0 ? "Star models in Settings to use them here." : "Your starred models are currently unavailable."),
        h("button", { class: "button button-small", type: "button", onClick: () => controller.openSettings("models") }, "Choose favorites"))] : []),
      ...(unknownRunId === undefined ? [] : [
        h("div", { class: "guard-warning" }, icon("warning-circle"),
          h("span", {}, "The last run ended with an unknown outcome. Review its details before continuing; nothing is replayed automatically."),
          h("button", { class: "button button-small", type: "button", onClick: () => controller.acknowledgeUnknown(unknownRunId) }, "I reviewed it")),
      ]),
    );
    guard.hidden = approvals.length === 0 && catalogMessage === undefined && !needsFavorites && unknownRunId === undefined;
    guard.classList.toggle("approval-open", approvals.length > 0);

    const noSession = state.session === undefined || state.selection.sessionId !== state.session.id || state.host.status !== "ready";
    const targetAccount = effectiveAccount(state);
    skills.update(state.session && selected && targetAccount ? { sessionId: state.session.id, runtimeId: selected.runtimeId, accountId: targetAccount.id, ...(state.session.projectId === undefined ? {} : { projectId: state.session.projectId }) } : undefined, noSession || submitting || activeId !== undefined);
    planToggle.disabled = noSession || submitting || activeId !== undefined;
    planToggle.setAttribute("aria-pressed", String(workflow === "plan"));
    planToggle.classList.toggle("active", workflow === "plan");
    planToggle.title = workflow === "plan" ? "Plan mode on · Research before implementing" : "Plan mode · Research before implementing";
    const latest = state.runs.at(-1);
    const readyPlan = latest?.interactionMode === "plan" && latest.status === "completed" && latest.result?.trim() && activeId === undefined ? latest : undefined;
    planCard.hidden = !readyPlan;
    if (readyPlan) replace(planCard,
      h("div", { class: "plan-ready-label" }, icon("list-checks"), h("span", {}, "Plan ready"), h("span", { class: "note" }, "Review the plan above before implementing.")),
      h("div", { class: "plan-ready-actions" },
        h("button", { class: "button button-small", type: "button", disabled: submitting, onClick: () => { workflow = "plan"; prompt.focus(); refresh(store.get()); } }, "Revise plan"),
        h("button", { class: "button button-primary button-small", type: "button", disabled: submitting || !canRun(state), onClick: () => { workflow = "normal"; void submitOrStop(readyPlan.id); } }, "Implement")));
    prompt.disabled = noSession || submitting;
    attachments.update(state.session?.id, noSession || submitting);
    prompt.placeholder = state.session === undefined ? "Open or start a session to run an agent" : workflow === "plan" ? "Describe what you want to plan…" : "Ask anything, or describe a task…";
    // The selection is sent when a run starts, not changed mid-turn. Keep
    // the picker truthful while active instead of showing a future setting.
    permission.setDisabled(noSession || activeId !== undefined);
    account.setDisabled(noSession);
    model.setDisabled(noSession || submitting);

    const active = activeRunId(state);
    if (active !== undefined) {
      const cancelling = state.live[active]?.cancelRequested === true;
      replace(send, icon("stop"));
      send.classList.add("is-stop"); send.disabled = cancelling; send.title = cancelling ? "Cancelling" : "Stop the running agent (Esc)";
      send.setAttribute("aria-label", send.title);
    } else {
      replace(send, submitting ? icon("circle-notch", { className: "spin" }) : icon("arrow-up"));
      const hasAttachments = state.session !== undefined && attachments.files(state.session.id).length > 0;
      send.classList.remove("is-stop"); send.disabled = submitting || attachments.busy || (prompt.value.trim() === "" && !hasAttachments) || !canRun(state);
      send.title = "Run (Enter)"; send.setAttribute("aria-label", "Run");
    }
  }

  store.watch(
    (state) => [state.models, state.favoriteModelKeys, state.modelCatalogFailures, state.runtimes, state.accounts, state.capabilities, state.session, state.selection.sessionId, state.runs, state.live, state.acknowledgedUnknown, state.host, activeKey(state)],
    (_slice, state) => refresh(state),
  );
}

function modelCatalogMessage(state: AppState): string | undefined {
  if (state.models.length > 0 && state.modelCatalogFailures.length === 0) return undefined;
  if (state.models.length === 0 && state.modelCatalogFailures.length === 0) {
    return "Connect a provider account to load its available models.";
  }
  if (state.models.length === 0) {
    return "No models are available. Check the connected provider accounts and try again.";
  }
  const count = state.modelCatalogFailures.length;
  return `${count} connected account${count === 1 ? "" : "s"} could not load its model list. Your available favorites are shown.`;
}

function pendingApprovals(state: AppState): readonly { readonly run: RunView; readonly live: LiveRun; readonly request: ApprovalRequest }[] {
  if (state.session === undefined) return [];
  return Object.values(state.live)
    .filter((live) => live.run.sessionId === state.session?.id)
    .flatMap((live) => live.pendingApprovals.map((request) => ({ run: live.run, live, request })));
}

/**
 * Renders one pending approval as "what you are approving" only: the action,
 * its target (command, file, or query), the proposed change or arguments,
 * and the provider's reason when given. Run/account/model metadata and IDs
 * are deliberately omitted; they remain available in the right panel's Run
 * details surface.
 *
 * The request is described with the same `presentTool` mapping the
 * transcript's activity cards use, so an approval reads like the activity
 * it will become. Unknown tool shapes still show their full arguments, so
 * nothing the user is approving is hidden.
 */
function renderApproval(request: ApprovalRequest, run: RunView, _live: LiveRun, _state: AppState, controller: Controller): HTMLElement {
  const view = presentTool({ kind: "tool", tool: request.tool, input: request.input, hasOutput: false, finished: false }, true);
  // The command or path is already the card's target line; repeating it as a
  // labelled section adds noise. Diffs and unknown arguments are kept.
  const sections = view.sections.filter((section) => section.label !== "Command" && section.label !== "Directory");
  return h("div", { class: "approval approval-overlay-card" },
    h("div", { class: "approval-head" },
      h("span", { class: "activity-icon" }, icon(view.icon)),
      h("span", { class: "approval-title" }, view.title)),
    view.subtitle === undefined ? null
      : view.path !== undefined
        ? h("pre", { class: "approval-target approval-path", title: `Open ${view.path}`, role: "link", onClick: () => void controller.openPath(view.path!) }, view.subtitle)
        : h("pre", { class: "approval-target" }, view.subtitle),
    ...sections.map((section) => section.format === "diff"
      ? h("pre", { class: "activity-diff approval-detail" }, h("code", {}, ...section.text.split("\n").map((line) =>
        h("span", { class: /^(@@|---|\+\+\+)/.test(line) ? "diff-header" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : "diff-context" }, line || " "))))
      : h("pre", { class: "activity-code approval-detail" }, section.text)),
    request.reason === undefined ? null : h("p", { class: "approval-reason" }, request.reason),
    // These controls live inside the composer form. A submit button would
    // also invoke submitOrStop(), cancelling the run just after answering it.
    h("div", { class: "approval-actions" },
      h("button", { class: "button", type: "button", onClick: () => void controller.respondToApproval(run.id, request.id, "deny") }, icon("x"), "Deny"),
      h("button", { class: "button button-primary", type: "button", onClick: () => void controller.respondToApproval(run.id, request.id, "allow") }, icon("check"), "Allow")),
  );
}

function parseChoice(value: AccountChoice | undefined): { providerId: string; accountId?: string } | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("auto:")) return { providerId: value.slice("auto:".length) };
  const [, providerId, accountId] = value.split(":");
  return providerId === undefined || accountId === undefined ? undefined : { providerId, accountId };
}

function activeKey(state: AppState): string {
  return Object.values(state.live).map((live) => `${live.run.id}:${live.run.status}:${live.cancelRequested}:${live.pendingApprovals.length}`).join("|");
}
