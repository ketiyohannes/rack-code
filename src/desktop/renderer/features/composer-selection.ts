/** Session initialization only. Unsent choices belong to the composer and must
 * not be replaced when late catalog/history events arrive for another chat. */
import type { PermissionMode } from "../../../contracts/desktop/index.js";
import type { AppState } from "../store.js";
import type { ModelPickerSelection } from "../components/model-picker.js";
import { resolveModelSelectionKey } from "../components/model-settings.js";

export type AccountChoice = `auto:${string}` | `account:${string}:${string}`;
export interface ComposerSelection {
  readonly model?: ModelPickerSelection;
  readonly account?: AccountChoice;
  readonly permissionMode: PermissionMode;
}

/** Root history and immutable workflow defaults are authoritative on first
 * visit. Worker executions never seed the main conversation's picker. */
export function initialComposerSelection(state: AppState, sessionId: string): ComposerSelection {
  const root = state.runs.filter((run) => run.sessionId === sessionId).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const workflow = state.orchestra.runs.filter((run) => run.sessionId === sessionId).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const useWorkflow = workflow && (!root || workflow.createdAt > root.createdAt);
  const binding = state.orchestra.workflows.find((entry) => entry.id === state.orchestra.bindings[sessionId]);
  const runtimeId = root?.attempts.at(-1)?.runtimeId ?? state.runtimes.find((entry) => entry.providerId === root?.providerId)?.runtimeId;
  const source = useWorkflow ? workflow.defaultModel : root && runtimeId ? { providerId: root.providerId, runtimeId, model: root.model ?? "default", reasoningEffort: root.reasoningEffort } : binding?.coordinator;
  const permissionMode = useWorkflow ? workflow.permissionMode : root?.permissionMode ?? "approve_for_me";
  if (!source) return { permissionMode };
  const key = resolveModelSelectionKey(state.models, `${source.providerId}|${source.runtimeId}|${source.model}`)!;
  const label = state.models.find((entry) => `${entry.providerId}|${entry.runtimeId}|${entry.id}` === key)?.label ?? source.model;
  const accountId = useWorkflow ? workflow.defaultAccountId : root?.accountId;
  return {
    permissionMode,
    model: { key, label, ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }), ...(!useWorkflow && root?.speed ? { speed: root.speed } : {}) },
    account: accountId ? `account:${source.providerId}:${accountId}` : `auto:${source.providerId}`,
  };
}
