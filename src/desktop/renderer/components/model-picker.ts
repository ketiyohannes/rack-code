/**
 * Compact composer dropdown for model, reasoning and speed. Its plain model
 * list contains only available favorites and transforms into the selected
 * model's reasoning slider and Fast tag. An empty list links to Settings.
 * Choices apply immediately to the next turn. The shared popover handles
 * outside clicks/Escape; content changes re-anchor it against the pill.
 *
 * Scope: the composer calls `setScope(sessionId, fallback)` so each session
 * keeps its own model, reasoning and Fast setting (see
 * `session-model-choice.ts`). An explicit choice in a scope is saved for that
 * session and also becomes the starting choice for new sessions. Without a
 * scope (the side chat) only the most recent choice is used and updated.
 */
import type { ModelView } from "../../../contracts/desktop/index.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openPopover, type PopoverHandle } from "./popover.js";
import { effortStops, fastOptions, modelKey, PROVIDER_DEFAULT, selectedEffort, selectedSpeed } from "./model-settings.js";
import { favoriteModels } from "../model-favorites.js";
import { choiceIdentity, loadSessionChoice, resolveChoice, saveSessionChoice, type ModelChoice } from "../session-model-choice.js";

export interface ModelPicker {
  readonly element: HTMLButtonElement;
  readonly selected: ModelView | undefined;
  readonly reasoningEffort: string | undefined;
  readonly speed: string | undefined;
  update(models: readonly ModelView[], favoriteKeys: readonly string[]): void;
  /**
   * Switches to a session's settings. `fallback` (usually its latest run)
   * applies while the session has no explicit choice, and is re-applied when
   * it changes, for example once the session's runs finish loading.
   */
  setScope(scope: string | undefined, fallback?: ModelChoice): void;
  setDisabled(disabled: boolean): void;
}

export function createModelPicker(onChange: () => void, onManageFavorites: () => void): ModelPicker {
  let models: readonly ModelView[] = [];
  let catalog: readonly ModelView[] | undefined;
  let favorites: readonly string[] | undefined;
  // The wanted model; `selected()` resolves it against the offered favorites
  // and falls back to the default without overwriting it, so a remembered
  // model that is still loading or briefly unavailable is not forgotten.
  let wanted: ModelChoice | undefined = globalModel();
  /** Speed option ID from a run-derived choice; used while `preferredFast` is unset. */
  let wantedSpeed: string | undefined;
  let scope: string | undefined;
  /** True when the current scope has an explicit, saved choice. */
  let explicit = false;
  let appliedFallback = "";
  let popover: PopoverHandle | undefined;
  let body: HTMLElement | undefined;
  let stage: "models" | "settings" = "models";
  let preferredEffort = load("composer.reasoningEffort");
  let preferredFast = globalFast();
  const legacySpeed = load("composer.speed");
  const selected = () => resolveChoice(models, wanted) ?? models.find((entry) => entry.isDefault) ?? models[0];
  const selectedKey = () => { const entry = selected(); return entry === undefined ? undefined : modelKey(entry); };
  const reasoning = () => {
    const entry = selected();
    const value = entry === undefined ? undefined : selectedEffort(entry, preferredEffort);
    return value === PROVIDER_DEFAULT ? undefined : value;
  };
  const speed = () => {
    const entry = selected();
    return entry === undefined ? undefined : selectedSpeed(entry, preferredFast, wantedSpeed ?? legacySpeed);
  };

  /** Loads a scope's choice, or the most recent global choice when `choice` is undefined. */
  function apply(choice: ModelChoice | undefined): void {
    wanted = choice ?? globalModel();
    preferredEffort = choice?.reasoningEffort ?? load("composer.reasoningEffort");
    // A run-derived choice names its speed by ID; explicit choices store Fast.
    preferredFast = choice === undefined ? globalFast() : choice.fast;
    wantedSpeed = choice?.speed;
  }

  /**
   * Records an explicit change: the resolved model, reasoning and Fast become
   * this session's settings. Only the setting that changed updates the global
   * starting choice, as before.
   */
  function remember(changed: "model" | "effort" | "fast"): void {
    const entry = selected();
    if (entry === undefined) return;
    const options = fastOptions(entry);
    const fast = options === undefined ? undefined : speed() === options.fast.id;
    const effort = selectedEffort(entry, preferredEffort);
    if (changed === "model") save("composer.model", modelKey(entry));
    if (changed === "effort" && effort !== undefined) save("composer.reasoningEffort", effort);
    if (changed === "fast" && fast !== undefined) save("composer.fast", String(fast));
    wanted = { modelKey: modelKey(entry) };
    if (fast !== undefined) preferredFast = fast;
    wantedSpeed = undefined;
    if (scope !== undefined) {
      saveSessionChoice(scope, { modelKey: modelKey(entry), ...(effort === undefined ? {} : { reasoningEffort: effort }), ...(fast === undefined ? {} : { fast }) });
      explicit = true;
    }
  }
  const trigger = h("button", {
    class: "dropdown dropdown-pill model-picker-trigger", type: "button",
    aria: { label: "Model settings", haspopup: "dialog", expanded: "false" },
    onClick: () => popover === undefined ? open() : popover.close(),
    onKeydown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); open(event.key === "ArrowUp");
      }
    },
  });

  function renderTrigger(): void {
    const entry = selected();
    const effort = entry === undefined ? undefined : effortStops(entry).find((stop) => stop.id === selectedEffort(entry, preferredEffort));
    const options = entry === undefined ? undefined : fastOptions(entry);
    const fast = options !== undefined && options.fast.id === speed();
    replace(trigger,
      h("span", { class: "dropdown-value" }, entry?.label ?? (catalog?.length ? "Choose favorites" : "Choose a model")),
      effort === undefined ? null : h("span", { class: "model-pill-effort" }, effort.label),
      fast ? icon("lightning", { className: "model-pill-fast" }) : null,
      icon("caret-up-down", { className: "dropdown-caret" }));
    trigger.title = [entry?.label ?? "Model settings", effort?.label, fast ? "Fast on" : undefined].filter(Boolean).join(" · ");
  }

  function open(last = false): void {
    if (trigger.disabled || popover !== undefined) return;
    stage = "models";
    body = h("div", { class: "model-picker-body", role: "dialog", aria: { label: "Model settings" } });
    body.addEventListener("keydown", (event) => {
      // Tab can move through the slider/ticks/Fast tag; at either end it
      // continues from the toolbar trigger after closing the dropdown.
      if (event.key !== "Tab") return;
      const items = [...body!.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      if (document.activeElement === (event.shiftKey ? items[0] : items.at(-1))) {
        trigger.focus(); popover?.close();
      }
    });
    renderBody();
    popover = openPopover({ anchor: trigger, content: body, minWidth: 250, maxWidth: 280, placement: "above", onClose: () => {
      popover = undefined; body = undefined; trigger.setAttribute("aria-expanded", "false");
    } });
    trigger.setAttribute("aria-expanded", "true");
    focusModel(last);
  }

  function focusModel(last = false): void {
    const items = [...(body?.querySelectorAll<HTMLButtonElement>(".model-choice") ?? [])];
    const target = last ? items.at(-1) : items.find((item) => item.dataset["modelKey"] === selectedKey()) ?? items[0];
    const focus = target ?? body?.querySelector<HTMLButtonElement>(".model-manage-favorites");
    focus?.focus(); focus?.scrollIntoView({ block: "nearest" });
  }

  function renderBody(): void {
    if (body === undefined) return;
    if (stage === "models") renderModels(body);
    else renderSettings(body);
    popover?.reposition();
  }

  function renderModels(container: HTMLElement): void {
    const list = h("div", { class: "model-choice-list", role: "group", aria: { label: "Models" } });
    const providers = [...new Set(models.map((entry) => entry.providerName))];
    replace(list, ...providers.flatMap((provider) => [
        h("div", { class: "menu-group" }, provider),
        ...models.filter((entry) => entry.providerName === provider).map((entry) => h("button", {
          class: `menu-item model-choice${modelKey(entry) === selectedKey() ? " selected" : ""}`, type: "button",
          title: entry.description ?? entry.label,
          aria: { pressed: String(modelKey(entry) === selectedKey()) }, data: { modelKey: modelKey(entry) },
          onClick: () => {
            // Keep the reasoning/Fast preference when switching models; the
            // new model resolves it against its own options.
            wanted = { modelKey: modelKey(entry) }; stage = "settings";
            remember("model");
            renderTrigger(); renderBody(); onChange();
            container.querySelector<HTMLElement>(".reasoning-slider:not(:disabled), .fast-toggle:not(:disabled), .model-done")?.focus();
          },
        }, h("span", { class: "menu-text" }, h("span", { class: "menu-label" }, entry.label)),
          modelKey(entry) === selectedKey() ? icon("check", { className: "menu-check" }) : null)),
      ]), models.length === 0 ? h("div", { class: "model-empty" },
        h("p", {}, "No favorite models available."),
        h("button", { class: "button button-small model-manage-favorites", type: "button", onClick: () => {
          popover?.close(); onManageFavorites();
        } }, "Choose favorites")) : null);
    list.addEventListener("keydown", (event) => {
      const items = [...list.querySelectorAll<HTMLButtonElement>(".model-choice")];
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      let target: number | undefined;
      if (event.key === "ArrowDown") target = (index + 1) % items.length;
      if (event.key === "ArrowUp") target = (index + items.length - 1) % items.length;
      if (event.key === "Home") target = 0;
      if (event.key === "End") target = items.length - 1;
      if (target !== undefined) { event.preventDefault(); items[target]?.focus(); }
    });
    replace(container, list);
  }

  function renderSettings(container: HTMLElement): void {
    const entry = selected();
    if (entry === undefined) { stage = "models"; renderModels(container); return; }
    const changeModel = h("button", {
      class: "model-selected", type: "button", aria: { label: "Change model" }, onClick: () => {
        stage = "models"; renderBody(); focusModel();
      },
    }, icon("arrow-left"), h("span", { class: "model-selected-name" }, entry.label));
    const stops = effortStops(entry);
    const output = h("span", { class: "reasoning-value" });
    const description = h("p", { class: "reasoning-description" });
    const slider = h("input", { class: "reasoning-slider", type: "range", aria: { label: "Reasoning effort" }, disabled: stops.length <= 1 });
    slider.min = "0"; slider.max = String(Math.max(0, stops.length - 1)); slider.step = "1";
    slider.value = String(Math.max(0, stops.findIndex((stop) => stop.id === selectedEffort(entry, preferredEffort))));
    const ticks = stops.map((stop, index) => h("button", {
      class: "reasoning-tick", type: "button", title: stop.description ?? stop.label,
      aria: { label: `Set reasoning to ${stop.label}` }, onClick: () => { slider.value = String(index); chooseEffort(); },
    }, stop.label));
    function syncEffort(): void {
      const index = Number(slider.value);
      const stop = stops[index];
      output.textContent = stop?.label ?? "Default";
      slider.setAttribute("aria-valuetext", stop?.label ?? "Default");
      slider.style.setProperty("--slider-progress", `${stops.length <= 1 ? 0 : index / (stops.length - 1) * 100}%`);
      ticks.forEach((tick, i) => { tick.classList.toggle("selected", i === index); tick.setAttribute("aria-pressed", String(i === index)); });
      description.textContent = stop?.description ?? (stops.length === 0 ? "This model manages its reasoning automatically." : stop?.id === PROVIDER_DEFAULT ? "Use the model's default reasoning." : "");
      description.hidden = description.textContent === "";
    }
    function chooseEffort(): void {
      const stop = stops[Number(slider.value)];
      if (stop === undefined) return;
      preferredEffort = stop.id; remember("effort");
      syncEffort(); renderTrigger(); onChange();
    }
    slider.addEventListener("input", chooseEffort);
    syncEffort();
    const options = fastOptions(entry);
    const fast = h("button", { class: "fast-toggle", type: "button", role: "switch", aria: { label: "Fast mode" }, disabled: options === undefined });
    function syncFast(): void {
      const enabled = options !== undefined && speed() === options.fast.id;
      fast.classList.toggle("enabled", enabled);
      fast.setAttribute("aria-checked", String(enabled));
      fast.title = options === undefined ? "Fast is unavailable for this model" : (enabled ? options.fast.description : options.standard.description) ?? "Fast mode";
      replace(fast, icon("lightning"), "Fast", h("span", { class: "fast-toggle-state" }, enabled ? "On" : "Off"));
    }
    fast.addEventListener("click", () => {
      if (options === undefined) return;
      preferredFast = speed() !== options.fast.id; remember("fast");
      syncFast(); renderTrigger(); onChange();
    });
    syncFast();
    replace(container, changeModel,
      h("div", { class: "reasoning-control" }, h("div", { class: "reasoning-heading" }, h("span", {}, "Reasoning"), output),
        stops.length === 0 ? null : slider,
        stops.length === 0 ? null : h("div", { class: "reasoning-ticks" }, ...ticks), description),
      h("div", { class: "model-settings-footer" }, fast,
        h("button", { class: "icon-button model-done", type: "button", title: "Done", aria: { label: "Done" }, onClick: () => {
          popover?.close(); trigger.focus();
        } }, icon("check"))));
  }

  renderTrigger();
  return {
    element: trigger, get selected() { return selected(); }, get reasoningEffort() { return reasoning(); }, get speed() { return speed(); },
    update(next, favoriteKeys) {
      if (catalog === next && favorites === favoriteKeys) return;
      const focused = body?.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : undefined;
      catalog = next; favorites = favoriteKeys;
      models = favoriteModels(next, favoriteKeys);
      renderTrigger(); renderBody();
      // Catalog refreshes may rebuild an open dropdown; restore the same control
      // by its accessible name without interpolating provider data into CSS.
      if (focused) [...(body?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])].find((node) => node.getAttribute("aria-label") === focused)?.focus();
    },
    setScope(next, fallback) {
      const identity = choiceIdentity(fallback);
      if (next === scope && (explicit || identity === appliedFallback)) return;
      if (next !== scope) {
        scope = next;
        const stored = next === undefined ? undefined : loadSessionChoice(next);
        explicit = stored !== undefined;
        apply(stored ?? fallback);
      } else apply(fallback);
      appliedFallback = identity;
      // Switching sessions returns an open dropdown to the model list.
      stage = "models";
      renderTrigger(); renderBody();
    },
    setDisabled(disabled) { trigger.disabled = disabled; if (disabled) popover?.close(); },
  };
}

/** The most recent explicit model choice, used for new sessions and the side chat. */
function globalModel(): ModelChoice | undefined {
  const key = load("composer.model");
  return key === undefined ? undefined : { modelKey: key };
}

function globalFast(): boolean | undefined {
  const value = load("composer.fast");
  return value === "true" ? true : value === "false" ? false : undefined;
}

function load(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}

function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Continue with the current in-memory choice. */ }
}
