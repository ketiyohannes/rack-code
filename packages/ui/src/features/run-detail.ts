/**
 * Run diagnostics, rendered in the right-side Run details surface: usage cards, labelled detail rows, permission mapping, status
 * guidance, recovery information, and the append-only journal.
 *
 * For finished runs, usage, failure retryability, and the last native
 * continuation are derived from the journal, which is the durable record.
 * For active runs they come from the live event fold.
 */
import type { JournalEntryView, RunView, RuntimeEvent } from "@rack/contracts";
import type { Controller } from "../controller.js";
import { formatData, formatTime, h, label, row, shortId, statCard } from "../dom.js";
import { icon } from "../icons.js";
import type { AppState } from "../store.js";
import { foldEvents, type TranscriptState } from "../transcript.js";
import { accountLabel, PERMISSION_LABELS, RUN_GUIDANCE, runtimeOf } from "./run-format.js";

/** Journal entry types that carry a `RuntimeEvent` payload. */
const RUNTIME_EVENT_TYPES = new Set<string>([
  "message_delta", "thinking_delta", "tool_request", "tool_result", "approval_request", "native_session",
  "question_request", "question_resolved",
  "usage", "availability", "completed", "failed", "interrupted",
]);

/**
 * Details for one run. `run` is the freshest view (live snapshot when the
 * run is active); the journal comes from state when it has been loaded for
 * this run.
 */
export function renderRunDetails(run: RunView, state: AppState, controller: Controller): HTMLElement {
  const effectivePermission = run.interactionMode === "plan" ? "read_only" : run.permissionMode;
  const live = state.live[run.id];
  const journal = state.journal?.runId === run.id ? state.journal.entries : undefined;
  const summary: TranscriptState = live !== undefined
    ? foldEvents(live.events)
    : foldEvents(journalEvents(journal ?? []));
  const attempt = run.attempts.at(-1);
  const account = state.accounts.find((candidate) => candidate.id === run.accountId);
  const project = state.projects.find((candidate) => candidate.id === run.projectId);
  const runtime = state.runtimes.find((candidate) => candidate.runtimeId === runtimeOf(run));
  const guidance = RUN_GUIDANCE[run.status];
  const nativeSession = attempt?.nativeSessionId ?? summary.nativeSessionId;
  const usage = summary.usage;

  return h("div", { class: "run-details" },
    h("div", { class: "stat-grid" },
      // Missing usage is shown as unavailable, never as zero.
      statCard("Tokens in", usage?.inputTokens === undefined ? "n/a" : formatCount(usage.inputTokens), { icon: icon("arrow-right") }),
      statCard("Tokens out", usage?.outputTokens === undefined ? "n/a" : formatCount(usage.outputTokens), { icon: icon("arrow-up") }),
      statCard("Cost", usage?.costUsd === undefined ? "n/a" : `$${usage.costUsd.toFixed(4)}`, { icon: icon("coins") }),
    ),
    h("div", { class: "details-columns" },
      h("div", { class: "detail-rows" },
        row("Runtime", runtimeOf(run)),
        row("Provider", run.providerId),
        row("Account", accountLabel(account, run.accountId)),
        row("Model", run.model ?? "default"),
        row("Reasoning effort", run.reasoningEffort ?? "default"),
        row("Speed", run.speed ?? "default"),
        row("Project", project?.path ?? (run.projectId === undefined ? "Chat workspace" : shortId(run.projectId))),
      ),
      h("div", { class: "detail-rows" },
        row("Workflow", run.interactionMode === "plan" ? "Plan" : "Normal"),
        row("Permission", PERMISSION_LABELS[effectivePermission].label),
        ...(run.interactionMode === "plan" ? [row("After approval", PERMISSION_LABELS[run.permissionMode].label)] : []),
        ...(run.skills?.length ? [row("Skills", run.skills.map((skill) => skill.name).join(", "))] : []),
        row("Attempt", `${shortId(attempt?.id)} (${run.attempts.length})`),
        row("Native session", shortId(nativeSession)),
        row("Created", formatTime(run.createdAt)),
        row("Updated", formatTime(run.updatedAt)),
      ),
    ),
    h("div", { class: "details-columns" },
      h("div", { class: "info-block" },
        label("Permission mapping"),
        h("p", {}, PERMISSION_LABELS[effectivePermission].note),
        runtime === undefined ? null : h("p", { class: "mono muted" }, runtime.permissionMappings[effectivePermission]),
      ),
      h("div", { class: "info-block" },
        label("Status"),
        h("p", {}, guidance.state),
        h("p", { class: "muted" }, guidance.actions),
      ),
    ),
    ...renderRecovery(run, summary, journal, nativeSession, account?.availability, state, controller),
    h("div", { class: "journal" },
      h("div", { class: "journal-head" }, label("Journal"), h("span", { class: "label" }, journal === undefined ? "" : String(journal.length))),
      ...(journal === undefined
        ? [h("p", { class: "muted" }, live !== undefined ? "The journal loads when the run finishes." : "Loading")]
        : journal.map((entry) => h("details", { class: "journal-entry" },
          h("summary", {},
            h("span", { class: "journal-seq" }, String(entry.sequence).padStart(3, "0")),
            h("span", { class: "journal-type" }, entry.type),
            h("span", { class: "journal-time" }, formatTime(entry.observedAt)),
            icon("caret-right", { className: "journal-caret" }),
          ),
          h("pre", {}, formatData(entry.payload)),
        ))),
    ),
  );
}

function renderRecovery(
  run: RunView,
  summary: TranscriptState,
  journal: readonly JournalEntryView[] | undefined,
  nativeSession: string | undefined,
  availability: string | undefined,
  state: AppState,
  controller: Controller,
): Node[] {
  const nodes: Node[] = [];
  if (run.status === "failed") {
    const error = summary.failure?.error ?? run.error ?? "No error text was recorded.";
    const retryable = summary.failure?.retryable;
    nodes.push(h("div", { class: "run-error" },
      icon("warning-circle"),
      h("span", {},
        error,
        h("span", { class: "run-error-note" }, retryable === undefined
          ? "The adapter did not say whether this is retryable."
          : retryable ? "The adapter marked this as retryable." : "The adapter marked this as not retryable."),
      ),
    ));
  }
  if (availability === "reauth_required") {
    nodes.push(h("button", { class: "button button-primary", onClick: () => controller.openReauthenticate(run.accountId) },
      icon("key"), "Re-authenticate account"));
  }
  if (run.status === "unknown") {
    const lastSequence = journal?.at(-1)?.sequence;
    nodes.push(h("div", { class: "guard" },
      h("div", { class: "detail-rows" },
        row("Last journal sequence", lastSequence === undefined ? "n/a" : String(lastSequence)),
        row("Last native continuation", shortId(nativeSession)),
      ),
      state.acknowledgedUnknown[run.id] === undefined
        ? h("button", { class: "button button-small", onClick: () => controller.acknowledgeUnknown(run.id) }, "I reviewed it")
        : h("span", { class: "muted" }, "Acknowledged."),
    ));
  }
  return nodes;
}

function journalEvents(entries: readonly JournalEntryView[]): RuntimeEvent[] {
  return entries
    .filter((entry) => RUNTIME_EVENT_TYPES.has(entry.type))
    .map((entry) => entry.payload as RuntimeEvent);
}

function formatCount(value: number): string {
  return value.toLocaleString();
}
