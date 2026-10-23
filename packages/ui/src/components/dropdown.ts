/**
 * Custom select replacement used everywhere instead of native `<select>`.
 *
 * Two visual variants share one implementation:
 * - `field`: full-width bordered control for forms;
 * - `pill`: compact rounded trigger for toolbars such as the composer.
 *
 * Options can carry an icon, a secondary description, a group heading, and
 * a disabled state with a reason (shown as the description). The menu opens
 * in a popover and follows the WAI-ARIA listbox pattern:
 * - trigger: Enter, Space, ArrowDown, or ArrowUp opens the menu;
 * - menu: ArrowUp/ArrowDown move between enabled options, Home/End jump,
 *   Enter or Space selects, Escape or Tab closes;
 * - typing a character jumps to the next option starting with it.
 *
 * The component owns only presentation state (open/closed, focus). The
 * selected value is set by the caller through `setValue`/`setOptions` and
 * reported back through `onChange`, so feature code stays the single owner
 * of what is selected.
 */
import { h, replace } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import { openPopover, type PopoverHandle } from "./popover.js";

export interface DropdownOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly icon?: IconName;
  readonly group?: string;
  readonly disabled?: boolean;
}

export interface DropdownConfig<T extends string> {
  readonly ariaLabel: string;
  readonly variant?: "field" | "pill";
  /** Icon shown in the trigger before the value. */
  readonly icon?: IconName;
  /** Compact toolbar control; the current value stays in its accessible name and tooltip. */
  readonly iconOnly?: boolean;
  /** Text shown when no option is selected. */
  readonly placeholder?: string;
  /** Optional trigger text override, e.g. a shorter form of the label. */
  readonly formatValue?: (option: DropdownOption<T>) => string;
  readonly menuWidth?: number;
  readonly align?: "start" | "end";
  readonly onChange: (value: T) => void;
}

export interface Dropdown<T extends string> {
  readonly element: HTMLButtonElement;
  readonly value: T | undefined;
  /** Replaces the options; keeps the current value when it is still present. */
  setOptions(options: readonly DropdownOption<T>[], value?: T): void;
  setValue(value: T | undefined): void;
  setDisabled(disabled: boolean): void;
}

let nextId = 0;

export function createDropdown<T extends string>(config: DropdownConfig<T>): Dropdown<T> {
  const id = `dropdown-${nextId++}`;
  let options: readonly DropdownOption<T>[] = [];
  let value: T | undefined;
  let popover: PopoverHandle | undefined;

  const triggerIcon = config.icon === undefined ? undefined : icon(config.icon, { className: "dropdown-icon" });
  const valueText = h("span", { class: "dropdown-value" });
  const trigger = h("button", {
    class: `dropdown dropdown-${config.variant ?? "field"}${config.iconOnly ? " dropdown-icon-only" : ""}`,
    type: "button",
    aria: { haspopup: "listbox", expanded: "false", label: config.ariaLabel },
    onClick: () => (popover === undefined ? open() : close()),
    onKeydown: (event) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        open(event.key === "ArrowUp" ? "last" : "selected");
      }
    },
  },
    triggerIcon,
    valueText,
    icon("caret-up-down", { className: "dropdown-caret" }),
  );

  function renderTrigger(): void {
    const selected = options.find((option) => option.value === value);
    const text = selected === undefined
      ? config.placeholder ?? "Select"
      : config.formatValue?.(selected) ?? selected.label;
    replace(valueText, text);
    trigger.classList.toggle("is-placeholder", selected === undefined);
    trigger.title = selected === undefined ? config.ariaLabel : `${config.ariaLabel}: ${selected.label}`;
    if (config.iconOnly) {
      trigger.setAttribute("aria-label", trigger.title);
      if (triggerIcon && (selected?.icon || config.icon)) replace(triggerIcon, icon(selected?.icon ?? config.icon!));
    }
  }

  function open(focus: "selected" | "last" = "selected"): void {
    if (trigger.disabled || options.length === 0) return;
    const list = h("div", { class: "menu", id, aria: { label: config.ariaLabel } });
    list.setAttribute("role", "listbox");
    const items: HTMLButtonElement[] = [];
    let group: string | undefined;
    for (const option of options) {
      if (option.group !== undefined && option.group !== group) {
        group = option.group;
        list.append(h("div", { class: "menu-group" }, option.group));
      }
      const item = h("button", {
        class: option.value === value ? "menu-item selected" : "menu-item",
        type: "button",
        disabled: option.disabled === true,
        aria: { selected: String(option.value === value) },
        onClick: () => choose(option),
      },
        option.icon === undefined ? null : icon(option.icon, { className: "menu-icon" }),
        h("span", { class: "menu-text" },
          h("span", { class: "menu-label" }, option.label),
          option.description === undefined ? null : h("span", { class: "menu-description" }, option.description),
        ),
        option.value === value ? icon("check", { className: "menu-check" }) : null,
      );
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.dataset["label"] = option.label.toLowerCase();
      items.push(item);
      list.append(item);
    }
    list.addEventListener("keydown", (event) => onMenuKey(event, items));

    popover = openPopover({
      anchor: trigger,
      content: list,
      ...(config.menuWidth === undefined ? {} : { minWidth: config.menuWidth }),
      ...(config.align === undefined ? {} : { align: config.align }),
      onClose: () => {
        popover = undefined;
        trigger.setAttribute("aria-expanded", "false");
      },
    });
    trigger.setAttribute("aria-expanded", "true");
    const enabled = items.filter((item) => !item.disabled);
    const target = focus === "last"
      ? enabled.at(-1)
      : enabled.find((item) => item.classList.contains("selected")) ?? enabled[0];
    target?.focus();
    target?.scrollIntoView({ block: "nearest" });
  }

  function onMenuKey(event: KeyboardEvent, items: readonly HTMLButtonElement[]): void {
    const enabled = items.filter((item) => !item.disabled);
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const move = (next: number) => {
      event.preventDefault();
      enabled[(next + enabled.length) % enabled.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(enabled.length - 1);
    else if (event.key === "Tab") {
      close();
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      const key = event.key.toLowerCase();
      const ordered = [...enabled.slice(index + 1), ...enabled.slice(0, index + 1)];
      ordered.find((item) => item.dataset["label"]?.startsWith(key))?.focus();
    }
  }

  function choose(option: DropdownOption<T>): void {
    if (option.disabled) return;
    close();
    trigger.focus();
    if (option.value !== value) {
      value = option.value;
      renderTrigger();
      config.onChange(option.value);
    }
  }

  function close(): void {
    popover?.close();
  }

  renderTrigger();
  return {
    element: trigger,
    get value() {
      return value;
    },
    setOptions(next, preferred) {
      options = next;
      const candidate = preferred ?? value;
      value = next.some((option) => option.value === candidate) ? candidate : undefined;
      renderTrigger();
    },
    setValue(next) {
      value = next;
      renderTrigger();
    },
    setDisabled(disabled) {
      trigger.disabled = disabled;
      if (disabled) close();
    },
  };
}
