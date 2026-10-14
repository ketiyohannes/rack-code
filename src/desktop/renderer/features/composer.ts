/**
 * Run composer: one card with an auto-growing prompt and a single toolbar of
 * compact pill menus (permission, account, model) and a round send
 * button. Details that used to sit in the composer now live in the menus:
 *
 * - Permission options describe what each mode does and show the
 *   adapter-reported native mapping. Modes that need interactive approvals
 *   are disabled, with the reason, when the runtime reports
 *   `approvals: false`. Nothing is inferred from runtime or provider names.
 * - The model picker combines the catalogs reported by Codex and Claude. A
 *   selected model carries its internal provider/runtime route, so the user
 *   never has to choose an implementation harness.
 * - The account menu groups accounts by provider. Each provider starts with
 *   an "Auto" entry, which lets the host choose the selected account or fall
 *   back; the account actually used is shown on the run after it starts.
 * - Permission requests are rendered above the composer, so the transcript
 *   remains focused on the assistant trace and tool activity.
 *
 * While the session has an active run, the send button becomes a stop
 * button that cancels it. If the session's latest run ended `unknown`,
 * a banner above the card blocks new runs until the user acknowledges it.
 *
 * Enter sends; Shift+Enter inserts a newline.
 */
import {
  PERMISSION_MODES,
  type AccountView,
  type ApprovalRequest,
  type PermissionMode,
  type RuntimeCapabilities,
} from "../../../contracts/desktop/index.js";
import { createDropdown, type DropdownOption } from "../components/dropdown.js";
import type { Controller } from "../controller.js";
import { dataView, h, replace } from "../dom.js";
import { icon } from "../icons.js";
import type { AppState, Store } from "../store.js";
import type { ModelView } from "../../../contracts/desktop/index.js";
import { accountLabel, isActiveStatus, PERMISSION_LABELS } from "./run-format.js";

/** Account menu values: `auto:<provider>` or `account:<provider>:<accountId>`. */
type AccountChoice = `auto:${string}` | `account:${string}:${string}`;
type ModelChoice = string;

const MODE_ICONS: Readonly<Record<PermissionMode, Parameters<typeof icon>[0]>> = {
  read_only: "lock-simple",
  ask: "hand",
  approve_for_me: "shield-check",
  full_access: "lightning",
};

export function mountComposer(root: HTMLElement, store: Store, controller: Controller): void {
  let mode: PermissionMode = "ask";
  let selectedModel: ModelView | undefined;
  let submitting = false;

  const permission = createDropdown<PermissionMode>({
    ariaLabel: "Permission mode",
    variant: "pill",
    icon: "shield",
    menuWidth: 340,
    onChange: (value) => {
      mode = value;
      refresh(store.get());
    },
  });
  const account = createDropdown<AccountChoice>({
    ariaLabel: "Account",
    variant: "pill",
    icon: "user",
    placeholder: "No accounts",
    menuWidth: 280,
    // The pill must name the provider, since "Auto" exists once per provider.
    formatValue: (option) => `${option.group ?? ""} · ${option.label.toLowerCase() === "auto" ? "auto" : option.label}`,
    onChange: () => refresh(store.get()),
  });
  const model = createDropdown<ModelChoice>({
    ariaLabel: "Model",
    variant: "pill",
    icon: "robot",
    placeholder: "Choose model",
    menuWidth: 360,
    formatValue: (option) => option.label,
    onChange: (value) => {
      selectedModel = modelView(store.get(), value);
      refresh(store.get());
    },
  });

  // Shown instead of the account menu until an account is connected.
  const connectPill = h("button", {
    class: "dropdown dropdown-pill",
    type: "button",
    onClick: () => controller.openSettings("accounts"),
  }, icon("plugs", { className: "dropdown-icon" }), h("span", { class: "dropdown-value" }, "Connect an account"));

  const prompt = h("textarea", {
    class: "prompt-input",
    rows: 1,
    placeholder: "Ask the agent to do something",
    aria: { label: "Prompt" },
  });
  const send = h("button", { class: "send-button", type: "submit" });
  const guard = h("div", { class: "guard" });
  const approvalOverlay = h("div", { class: "approval-overlay", role: "status" });
  approvalOverlay.hidden = true;

  const form = h("form", { class: "composer", onSubmit: (event) => {
    event.preventDefault();
    void submitOrStop();
  } },
    guard,
    approvalOverlay,
    h("div", { class: "composer-card" },
      prompt,
      h("div", { class: "composer-toolbar" },
        h("div", { class: "composer-pills" }, permission.element, account.element, connectPill, model.element),
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
  prompt.addEventListener("input", () => {
    autoGrow();
    refresh(store.get());
  });

  function autoGrow(): void {
    prompt.style.height = "auto";
    prompt.style.height = `${Math.min(prompt.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  /** Active run of the open session, if any; the send button cancels it. */
  function activeRunId(state: AppState): string | undefined {
    return Object.values(state.live).find((live) =>
      live.run.sessionId === state.session?.id && isActiveStatus(live.run.status))?.run.id;
  }

  async function submitOrStop(): Promise<void> {
    const state = store.get();
    const active = activeRunId(state);
    if (active !== undefined) {
      if (!state.live[active]?.cancelRequested) await controller.cancelRun(active);
      return;
    }
    const session = state.session;
    const text = prompt.value.trim();
    const choice = parseChoice(account.value);
    if (submitting || session === undefined || text === "" || choice === undefined || selectedModel === undefined || !canRun(state)) return;
    submitting = true;
    refresh(state);
    const ok = await controller.startRun({
      sessionId: session.id,
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      runtimeId: selectedModel.runtimeId,
      providerId: selectedModel.providerId,
      ...(choice.accountId === undefined ? {} : { accountId: choice.accountId }),
      model: selectedModel.modelId,
      prompt: text,
      permissionMode: mode,
    });
    submitting = false;
    if (ok) {
      prompt.value = "";
      autoGrow();
    }
    refresh(store.get());
  }

  /** Latest run of the session if it ended `unknown` and was not acknowledged. */
  function unacknowledgedUnknown(state: AppState): string | undefined {
    const last = state.runs.at(-1);
    return last?.status === "unknown" && state.acknowledgedUnknown[last.id] === undefined ? last.id : undefined;
  }

  function canRun(state: AppState): boolean {
    return state.session !== undefined &&
      state.host.status === "ready" &&
      selectedModel !== undefined &&
      account.value !== undefined &&
      unacknowledgedUnknown(state) === undefined &&
      !modeDisabled(capabilitiesFor(state));
  }

  function effectiveAccount(state: AppState): AccountView | undefined {
    const choice = parseChoice(account.value);
    if (choice === undefined) return undefined;
    return choice.accountId === undefined
      ? state.accounts.find((entry) => entry.providerId === choice.providerId && entry.selected)
      : state.accounts.find((entry) => entry.id === choice.accountId);
  }

  function capabilitiesFor(state: AppState): RuntimeCapabilities | undefined {
    const target = effectiveAccount(state);
    if (selectedModel === undefined || target === undefined) return undefined;
    const key = `${selectedModel.runtimeId}|${target.id}`;
    const caps = state.capabilities[key];
    if (caps === undefined) void controller.loadCapabilities(selectedModel.runtimeId, target.id);
    return caps;
  }

  function modeDisabled(caps: RuntimeCapabilities | undefined): boolean {
    return caps !== undefined && !caps.approvals && needsApprovals(mode);
  }

  function refresh(state: AppState): void {
    // Model menu: each option contains the hidden route to its runtime.
    const modelOptions: DropdownOption<ModelChoice>[] = state.models.map((entry) => ({
      value: modelKey(entry),
      label: entry.displayName,
      icon: "robot",
      group: providerLabel(entry.providerId),
      description: entry.description,
    }));
    const preferredModel = selectedModel !== undefined && state.models.some((entry) => modelKey(entry) === modelKey(selectedModel))
      ? selectedModel
      : state.models.find((entry) => entry.isDefault) ?? state.models[0];
    model.setOptions(modelOptions, preferredModel === undefined ? undefined : modelKey(preferredModel));
    selectedModel = modelView(state, model.value);

    // Account menu: grouped by provider, each with an Auto entry first.
    const modelProvider = selectedModel?.providerId;
    const providers = [...new Set(state.accounts
      .filter((entry) => modelProvider === undefined || entry.providerId === modelProvider)
      .map((entry) => entry.providerId))].sort();
    const accountOptions: DropdownOption<AccountChoice>[] = providers.flatMap((providerId) => {
      const accounts = state.accounts.filter((entry) => entry.providerId === providerId);
      const selected = accounts.find((entry) => entry.selected);
      return [
        {
          value: `auto:${providerId}` as const,
          label: `Auto`,
          description: selected === undefined
            ? "No selected account; the host picks an available one"
            : `Selected: ${accountLabel(selected)}, with fallback if unavailable`,
          icon: "sliders-horizontal" as const,
          group: providerId,
        },
        ...accounts.map((entry): DropdownOption<AccountChoice> => ({
          value: `account:${providerId}:${entry.id}`,
          label: accountLabel(entry),
          description: entry.availability.replace("_", " "),
          icon: "user-circle",
          group: providerId,
        })),
      ];
    });
    account.element.hidden = accountOptions.length === 0;
    connectPill.hidden = accountOptions.length > 0;
    const firstProvider = providers[0];
    const currentAccount = account.value !== undefined && accountOptions.some((option) => option.value === account.value)
      ? account.value
      : firstProvider === undefined ? undefined : `auto:${firstProvider}`;
    account.setOptions(accountOptions, currentAccount);

    const target = effectiveAccount(state);

    // Permission menu: descriptions carry the app meaning and native mapping.
    const caps = capabilitiesFor(state);
    const runtimeView = selectedModel === undefined
      ? undefined
      : state.runtimes.find((entry) => entry.runtimeId === selectedModel.runtimeId);
    permission.setOptions(PERMISSION_MODES.map((candidate) => {
      const unavailable = caps !== undefined && !caps.approvals && needsApprovals(candidate);
      return {
        value: candidate,
        label: PERMISSION_LABELS[candidate].label,
        icon: MODE_ICONS[candidate],
        disabled: unavailable,
        description: unavailable
          ? "This runtime does not support interactive approvals."
          : `${PERMISSION_LABELS[candidate].note}${runtimeView === undefined ? "" : ` Native: ${runtimeView.permissionMappings[candidate]}`}`,
      };
    }), mode);

    const unknownRunId = unacknowledgedUnknown(state);
    replace(guard, ...(unknownRunId === undefined ? [] : [
      icon("warning-circle"),
      h("span", {}, "The last run ended with an unknown outcome. Review its details before continuing; nothing is replayed automatically."),
      h("button", { class: "button button-small", type: "button", onClick: () => controller.acknowledgeUnknown(unknownRunId) }, "I reviewed it"),
    ]));
    guard.hidden = unknownRunId === undefined;

    const pending = pendingApproval(state);
    replace(approvalOverlay, pending === undefined ? null : renderApprovalOverlay(pending.request, pending.live.run.id, controller));
    approvalOverlay.hidden = pending === undefined;

    const noSession = state.session === undefined || state.host.status !== "ready";
    prompt.disabled = noSession;
    prompt.placeholder = state.session === undefined ? "Open or start a session to run an agent" : "Ask the agent to do something";
    for (const control of [permission, account, model]) control.setDisabled(noSession);

    const active = activeRunId(state);
    if (active !== undefined) {
      const cancelling = state.live[active]?.cancelRequested === true;
      replace(send, icon("stop"));
      send.classList.add("is-stop");
      send.disabled = cancelling;
      send.title = cancelling ? "Cancelling" : "Stop the running agent";
      send.setAttribute("aria-label", send.title);
    } else {
      replace(send, submitting ? icon("circle-notch", { className: "spin" }) : icon("arrow-up"));
      send.classList.remove("is-stop");
      send.disabled = submitting || prompt.value.trim() === "" || !canRun(state);
      send.title = "Run (Enter)";
      send.setAttribute("aria-label", "Run");
    }
  }

  store.watch(
    (state) => [state.models, state.runtimes, state.accounts, state.capabilities, state.session, state.runs, state.acknowledgedUnknown, state.host, activeKey(state)],
    (_slice, state) => refresh(state),
  );
}

function pendingApproval(state: AppState): { readonly live: LiveRun; readonly request: ApprovalRequest } | undefined {
  const sessionId = state.session?.id;
  if (sessionId === undefined) return undefined;
  for (const live of Object.values(state.live)) {
    if (live.run.sessionId !== sessionId) continue;
    const request = live.pendingApprovals[0];
    if (request !== undefined) return { live, request };
  }
  return undefined;
}

function renderApprovalOverlay(request: ApprovalRequest, runId: string, controller: Controller): HTMLElement {
  return h("div", { class: "approval-overlay-card" },
    h("div", { class: "approval-head" },
      icon("hand"),
      h("span", { class: "approval-title" }, `Allow ${request.tool}?`),
    ),
    request.reason === undefined ? null : h("p", { class: "approval-reason" }, request.reason),
    dataView("Input", request.input),
    h("div", { class: "approval-actions" },
      h("button", { class: "button", type: "button", onClick: () => void controller.respondToApproval(runId, request.id, "deny") }, "Deny"),
      h("button", { class: "button button-primary", type: "button", onClick: () => void controller.respondToApproval(runId, request.id, "allow") }, "Allow"),
    ),
  );
}

function needsApprovals(mode: PermissionMode): boolean {
  return mode === "ask" || mode === "approve_for_me";
}

function parseChoice(value: AccountChoice | undefined): { providerId: string; accountId?: string } | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("auto:")) return { providerId: value.slice("auto:".length) };
  const [, providerId, accountId] = value.split(":");
  return providerId === undefined || accountId === undefined ? undefined : { providerId, accountId };
}

function modelKey(model: ModelView): ModelChoice {
  return `${model.providerId}:${model.runtimeId}:${model.modelId}`;
}

function modelView(state: AppState, key: ModelChoice | undefined): ModelView | undefined {
  return key === undefined ? undefined : state.models.find((entry) => modelKey(entry) === key);
}

function providerLabel(providerId: string): string {
  return providerId === "codex" ? "Codex" : providerId === "claude" ? "Claude" : providerId;
}

/** Changes only when the set of active runs or their cancel state changes. */
function activeKey(state: AppState): string {
  return Object.values(state.live).map((live) => `${live.run.id}:${live.run.status}:${live.cancelRequested}`).join("|");
}
