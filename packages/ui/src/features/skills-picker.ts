/** Per-session selections are scoped to the model's runtime/account. Catalogs
 * are refreshed on opening; stale discovery cannot mutate another session.
 */
import type { RuntimeSkill, SkillCatalog } from "@rack/core/execution/types";
import type { Controller } from "../controller.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openModal, type ModalHandle } from "../components/modal.js";

export function createSkillsPicker(controller: Controller, changed: () => void) {
  let context: { sessionId: string; runtimeId: string; accountId: string; projectId?: string } | undefined;
  let key = ""; let generation = 0; let modal: ModalHandle | undefined;
  const selections = new Map<string, RuntimeSkill[]>();
  const chips = h("div", { class: "skill-chips" });
  const trigger = h("button", { class: "icon-button composer-action skills-trigger", type: "button", aria: { label: "Choose installed skills" }, title: "Installed skills (/)" , onClick: () => open() }, icon("sparkle"));
  function renderChips(): void {
    const selected = selections.get(key) ?? [];
    replace(chips, ...selected.map((skill) => h("button", { class: "skill-chip", type: "button", title: `Remove ${skill.name}`, onClick: () => { selections.set(key, selected.filter((entry) => entry.id !== skill.id)); renderChips(); changed(); } }, skill.name, icon("x"))));
    chips.hidden = !selected.length;
    trigger.setAttribute("aria-pressed", String(selected.length > 0));
    trigger.title = selected.length ? `Installed skills · ${selected.length} selected (/)` : "Installed skills (/)";
  }
  function open(query = ""): void {
    if (!context || trigger.disabled) return;
    modal?.close(); const target = context; const targetKey = key; const version = ++generation;
    let catalog: SkillCatalog = { skills: [], errors: [] }; let loading = true;
    const search = h("input", { class: "files-filter", type: "search", placeholder: "Search installed skills", aria: { label: "Search skills" }, value: query, onInput: () => draw() });
    const status = h("p", { class: "note", role: "status" });
    const list = h("div", { class: "skills-list" });
    const refresh = h("button", { class: "button button-small", type: "button", onClick: () => void load() }, "Refresh");
    function draw(): void {
      if (version !== generation) return;
      const selected = selections.get(targetKey) ?? [];
      const visible = catalog.skills.filter((skill) => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(search.value.toLowerCase()));
      status.textContent = loading ? "Reading installed skills…" : catalog.errors.join(" ") || (visible.length ? `${selected.length}/16 selected · Skills for the current model and account` : "No installed skills found for this model. Try Refresh after installing one.");
      refresh.disabled = loading;
      replace(list, ...visible.map((skill) => h("button", { class: "skill-option", type: "button", disabled: !skill.enabled || (selected.length >= 16 && !selected.some((entry) => entry.id === skill.id)), aria: { pressed: String(selected.some((entry) => entry.id === skill.id)) }, title: skill.path, onClick: () => {
        selections.set(targetKey, selected.some((entry) => entry.id === skill.id) ? selected.filter((entry) => entry.id !== skill.id) : [...selected, skill]); renderChips(); draw(); changed();
      } }, h("span", { class: "skill-option-title" }, skill.name, h("span", { class: "chip" }, skill.enabled ? skill.source : "Disabled")), h("span", { class: "note" }, skill.description))));
    }
    async function load(): Promise<void> {
      loading = true; draw();
      try {
        const result = await controller.listSkills(target.sessionId, target.runtimeId, target.accountId);
        if (version !== generation || targetKey !== key) return;
        catalog = result;
        const available = new Set(result.skills.filter((entry) => entry.enabled).map((entry) => entry.id));
        selections.set(targetKey, (selections.get(targetKey) ?? []).filter((entry) => available.has(entry.id)));
        renderChips(); changed();
      } catch (error) { if (version === generation) catalog = { skills: [], errors: [error instanceof Error ? error.message : "Could not load skills."] }; }
      finally { if (version === generation) { loading = false; draw(); } }
    }
    modal = openModal({ title: "Installed skills", className: "skills-modal", onClose: () => { generation++; modal = undefined; }, content: h("div", { class: "modal-body" },
      search, status, list, h("div", { class: "modal-actions" }, refresh, h("button", { class: "button button-primary", type: "button", onClick: () => modal?.close() }, "Done"))) });
    void load();
  }
  return {
    trigger, chips, open,
    ids: () => (selections.get(key) ?? []).map((entry) => entry.id),
    update(next: typeof context, disabled: boolean) {
      const nextKey = next ? `${next.sessionId}|${next.runtimeId}|${next.accountId}|${next.projectId ?? "chat"}` : "";
      if (nextKey !== key) { modal?.close(); generation++; key = nextKey; context = next; renderChips(); }
      trigger.disabled = disabled || !next;
    },
  };
}
