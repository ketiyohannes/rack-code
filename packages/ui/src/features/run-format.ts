/**
 * Shared presentation helpers for runs and accounts: status badges, labels,
 * and the per-status guidance table from the UI specification.
 *
 * Status is always shown as an icon plus a word, never as a colored dot, so
 * it reads the same in light and dark themes.
 */
import type { AccountAvailability, AccountView, PermissionMode, RunView } from "@rack/contracts";
import { badge } from "../dom.js";
import { icon, type IconName } from "../icons.js";

type RunStatus = RunView["status"];

const RUN_ICONS: Readonly<Record<RunStatus, IconName>> = {
  queued: "clock",
  running: "circle-notch",
  completed: "check-circle",
  failed: "x-circle",
  interrupted: "stop-circle",
  unknown: "question",
};

const AVAILABILITY_ICONS: Readonly<Record<AccountAvailability, IconName>> = {
  available: "check-circle",
  unknown: "question",
  unavailable: "prohibit",
  reauth_required: "key",
};

/** Run status badge; active runs get a spinning icon. */
export function runBadge(status: RunStatus): HTMLElement {
  return badge(icon(RUN_ICONS[status], { className: status === "running" ? "spin" : "" }), status, `badge-${status}`);
}

export function availabilityBadge(availability: AccountAvailability): HTMLElement {
  return badge(icon(AVAILABILITY_ICONS[availability]), availability.replace("_", " "), `badge-${availability}`);
}

/** UI state description and allowed user actions per run status (spec table). */
export const RUN_GUIDANCE: Readonly<Record<RunStatus, { readonly state: string; readonly actions: string }>> = {
  queued: { state: "Waiting for project and runtime.", actions: "Cancel, or inspect the selected account and project." },
  running: { state: "Streaming transcript and tool activity.", actions: "Respond to approvals or cancel." },
  completed: { state: "Completed; the assistant message is saved to the session.", actions: "Start another run to continue the session." },
  failed: { state: "The provider or host reported an error.", actions: "Review the account and project, then retry. Re-authenticate when indicated." },
  interrupted: { state: "Interrupted by the user or the runtime.", actions: "Inspect the partial transcript; continue with a new run." },
  unknown: {
    state: "The provider ended without a terminal outcome. Side effects may or may not have happened.",
    actions: "Inspect the journal and decide explicitly before continuing. Nothing is replayed automatically.",
  },
};

export const PERMISSION_LABELS: Readonly<Record<PermissionMode, { readonly key: string; readonly label: string; readonly note: string }>> = {
  read_only: { key: "RO", label: "Read only", note: "Uses the runtime's read-only sandbox or planning mode; attempted mutations are denied." },
  ask: { key: "ASK", label: "Ask me", note: "Every provider approval is presented to you." },
  approve_for_me: {
    key: "AUTO",
    label: "Approve for me",
    note: "The runtime's built-in automatic reviewer approves or denies actions. Rack does not prompt for tool approval.",
  },
  full_access: { key: "FULL", label: "Full access", note: "No approval prompts; the runtime bypasses its native checks within host permissions." },
};

export function accountLabel(account: AccountView | undefined, fallbackId?: string): string {
  if (account === undefined) return fallbackId === undefined ? "n/a" : fallbackId.slice(0, 8);
  return account.identity.displayName ?? account.identity.email ?? account.identity.providerAccountId;
}

export function runtimeOf(run: RunView): string {
  return run.attempts.at(-1)?.runtimeId ?? "n/a";
}

export function isActiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}
