/**
 * Pill picker for a per-model provider option, such as reasoning effort or
 * speed.
 *
 * The options always come from the selected model's catalog entry, so the
 * picker never offers a value the provider did not report, and it hides
 * itself for models that report none. The app does not interpret the
 * values: the chosen ID is sent back to the provider unchanged, and what it
 * does (depth, tier, pricing, fallback) is provider behavior.
 *
 * Selection rules, applied whenever the model or its catalog changes:
 * 1. the user's last explicit choice (a per-device preference under
 *    `storageKey`), when the selected model offers it;
 * 2. otherwise the model's reported default;
 * 3. otherwise "Default", which sends nothing so the provider decides.
 */
import { createDropdown, type DropdownOption } from "./dropdown.js";
import type { IconName } from "../icons.js";

/** One provider-reported option, already labelled for display. */
export interface ModelOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface ModelOptionPickerConfig {
  readonly ariaLabel: string;
  readonly icon: IconName;
  /** `localStorage` key for the user's last explicit choice. */
  readonly storageKey: string;
  /** Description of the synthetic "Default" option. */
  readonly defaultDescription: string;
  readonly onChange: () => void;
}

export interface ModelOptionPicker {
  readonly element: HTMLButtonElement;
  /** Rebuilds the options for the selected model; hides the pill when there are none. */
  update(options: readonly ModelOption[] | undefined, reportedDefault: string | undefined): void;
  /**
   * The value to send for a model offering `options`, or `undefined` to send
   * nothing (the provider default). Re-validated against the options so a
   * stale selection can never reach the host.
   */
  chosen(options: readonly ModelOption[] | undefined): string | undefined;
  setDisabled(disabled: boolean): void;
}

/** Sentinel for "send nothing": the provider applies its own default. */
const PROVIDER_DEFAULT = "__default__";

export function createModelOptionPicker(config: ModelOptionPickerConfig): ModelOptionPicker {
  let preferred = load(config.storageKey);
  const dropdown = createDropdown<string>({
    ariaLabel: config.ariaLabel, variant: "pill", icon: config.icon, menuWidth: 240,
    onChange: (value) => {
      preferred = value;
      save(config.storageKey, value);
      config.onChange();
    },
  });

  return {
    element: dropdown.element,
    update(options, reportedDefault) {
      const list = options ?? [];
      dropdown.element.hidden = list.length === 0;
      if (list.length === 0) {
        dropdown.setOptions([], undefined);
        return;
      }
      const known = reportedDefault !== undefined && list.some((option) => option.id === reportedDefault) ? reportedDefault : undefined;
      const entries: DropdownOption<string>[] = [
        // Without a reported default, "Default" lets the provider decide.
        ...(known === undefined ? [{ value: PROVIDER_DEFAULT, label: "Default", description: config.defaultDescription }] : []),
        ...list.map((option): DropdownOption<string> => {
          const description = [option.id === known ? "Default" : undefined, option.description].filter(Boolean).join(" / ");
          return { value: option.id, label: option.label, ...(description === "" ? {} : { description }) };
        }),
      ];
      dropdown.setOptions(entries, entries.some((entry) => entry.value === preferred) ? preferred : known ?? PROVIDER_DEFAULT);
    },
    chosen(options) {
      const value = dropdown.value;
      return value === undefined || value === PROVIDER_DEFAULT || !(options ?? []).some((option) => option.id === value) ? undefined : value;
    },
    setDisabled(disabled) {
      dropdown.setDisabled(disabled);
    },
  };
}

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? PROVIDER_DEFAULT;
  } catch {
    return PROVIDER_DEFAULT;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A lost preference falls back to the model default next time.
  }
}
