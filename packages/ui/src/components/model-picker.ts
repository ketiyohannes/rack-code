/**
 * Compact composer dropdown for model, reasoning and speed. Its plain model
 * list contains only available favorites and transforms into the selected
 * model's reasoning slider and Fast tag. An empty list links to Settings.
 * Choices apply immediately to the next turn. The shared popover handles
 * outside clicks/Escape; content changes re-anchor it against the pill.
 *
 * The composer owns each conversation's selection and restores it with
 * `setSelection`; explicit choices are persisted per session through
 * `session-model-choice.ts`. Every explicit change also updates the global
 * starting choice: without a selection (a new session or the side chat) the
 * picker uses the last chosen model while it is offered, else the default.
 */
import type { ModelView } from "@rack/contracts";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openPopover, type PopoverHandle } from "./popover.js";
import { effortStops, fastOptions, modelKey, PROVIDER_DEFAULT, selectedEffort, selectedSpeed, resolveModelSelectionKey } from "./model-settings.js";
import { favoriteModels } from "../model-favorites.js";

export interface ModelPicker {
  readonly element: HTMLButtonElement;
  readonly selected: ModelView | undefined;
  readonly reasoningEffort: string | undefined;
  readonly speed: string | undefined;
  /** Retains routing even when the catalog/favorites temporarily omit it. */
  readonly selection: ModelPickerSelection | undefined;
  readonly unavailable: boolean;
  /** Restores a session choice without firing onChange or choosing a substitute. */
  setSelection(selection: ModelPickerSelection | undefined): void;
  update(models: readonly ModelView[], favoriteKeys: readonly string[]): void;
  setDisabled(disabled: boolean): void;
}

export interface ModelPickerSelection {
  readonly key: string;
  readonly label?: string;
  readonly reasoningEffort?: string;
  readonly speed?: string;
  /** Fast preference to resolve against the model's options when `speed` is absent. */
  readonly fast?: boolean;
}

export function createModelPicker(onChange: () => void, onManageFavorites: () => void): ModelPicker {
  let models: readonly ModelView[] = [];
  let catalog: readonly ModelView[] | undefined;
  let favorites: readonly string[] | undefined;
  let selectedKey: string | undefined;
  let selectedLabel: string | undefined;
  let popover: PopoverHandle | undefined;
  let body: HTMLElement | undefined;
  let stage: "models" | "settings" = "models";
  let preferredEffort = load("composer.reasoningEffort");
  let preferredFast = globalFast();
  let legacySpeed = load("composer.speed");
  const selected = () => models.find((entry) => modelKey(entry) === selectedKey);
  const reasoning = () => {
    const entry = selected();
    const value = entry === undefined ? undefined : selectedEffort(entry, preferredEffort);
    return value === PROVIDER_DEFAULT ? undefined : value;
  };
  const speed = () => {
    const entry = selected();
    return entry === undefined ? undefined : selectedSpeed(entry, preferredFast, legacySpeed);
  };
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
      h("span", { class: "dropdown-value" }, entry?.label ?? (selectedKey ? `${selectedLabel ?? selectedKey.split("|").at(-1)} · unavailable` : catalog?.length ? "Choose favorites" : "Choose a model")),
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
    const target = last ? items.at(-1) : items.find((item) => item.dataset["modelKey"] === selectedKey) ?? items[0];
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
          class: `menu-item model-choice${modelKey(entry) === selectedKey ? " selected" : ""}`, type: "button",
          title: entry.description ?? entry.label,
          aria: { pressed: String(modelKey(entry) === selectedKey) }, data: { modelKey: modelKey(entry) },
          onClick: () => {
            selectedKey = modelKey(entry); selectedLabel = entry.label; stage = "settings";
            save("composer.model", selectedKey);
            renderTrigger(); renderBody(); onChange();
            container.querySelector<HTMLElement>(".reasoning-slider:not(:disabled), .fast-toggle:not(:disabled), .model-done")?.focus();
          },
        }, h("span", { class: "menu-text" }, h("span", { class: "menu-label" }, entry.label)),
          modelKey(entry) === selectedKey ? icon("check", { className: "menu-check" }) : null)),
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
      preferredEffort = stop.id; save("composer.reasoningEffort", stop.id);
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
      preferredFast = speed() !== options.fast.id; save("composer.fast", String(preferredFast));
      legacySpeed = speed();
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
    get selection() {
      const effort = selected() ? reasoning() : preferredEffort === PROVIDER_DEFAULT ? undefined : preferredEffort;
      const chosenSpeed = selected() ? speed() : legacySpeed;
      return selectedKey ? { key: selectedKey, label: selected()?.label ?? selectedLabel ?? selectedKey.split("|").at(-1)!, ...(effort === undefined ? {} : { reasoningEffort: effort }), ...(chosenSpeed === undefined ? {} : { speed: chosenSpeed }) } : undefined;
    },
    get unavailable() { return selectedKey !== undefined && selected() === undefined; },
    setSelection(value) {
      popover?.close();
      selectedKey = resolveModelSelectionKey(catalog ?? [], value?.key); selectedLabel = value?.label;
      // Without a selection, start from the global choice like a new picker.
      preferredEffort = value === undefined ? load("composer.reasoningEffort") : value.reasoningEffort ?? PROVIDER_DEFAULT;
      legacySpeed = value === undefined ? load("composer.speed") : value.speed;
      preferredFast = value === undefined ? globalFast() : value.fast;
      renderTrigger();
    },
    update(next, favoriteKeys) {
      if (catalog === next && favorites === favoriteKeys && selectedKey !== undefined) return;
      const focused = body?.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : undefined;
      if (selected()) { legacySpeed = speed(); selectedLabel = selected()!.label; }
      catalog = next; favorites = favoriteKeys;
      selectedKey = resolveModelSelectionKey(next, selectedKey);
      models = favoriteModels(next, favoriteKeys);
      if (selectedKey === undefined) {
        const last = load("composer.model");
        const first = models.find((entry) => modelKey(entry) === last) ?? models.find((entry) => entry.isDefault) ?? models[0];
        selectedKey = first === undefined ? undefined : modelKey(first);
      }
      renderTrigger(); renderBody();
      // Catalog refreshes may rebuild an open dropdown; restore the same control
      // by its accessible name without interpolating provider data into CSS.
      if (focused) [...(body?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])].find((node) => node.getAttribute("aria-label") === focused)?.focus();
    },
    setDisabled(disabled) { trigger.disabled = disabled; if (disabled) popover?.close(); },
  };
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
