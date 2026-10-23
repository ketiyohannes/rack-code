/**
 * Tiny DOM construction helpers for the framework-free renderer.
 *
 * `h()` builds elements declaratively. Text is always assigned through text
 * nodes, never `innerHTML`, so provider output and tool payloads cannot
 * inject markup.
 */

type Child = Node | string | number | false | null | undefined;

export interface Props {
  readonly class?: string | false | undefined;
  readonly title?: string;
  readonly role?: string;
  readonly type?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly selected?: boolean;
  readonly name?: string;
  readonly for?: string;
  readonly id?: string;
  readonly rows?: number;
  readonly open?: boolean;
  readonly data?: Readonly<Record<string, string>>;
  readonly aria?: Readonly<Record<string, string>>;
  readonly onClick?: (event: MouseEvent) => void;
  readonly onInput?: (event: Event) => void;
  readonly onChange?: (event: Event) => void;
  readonly onSubmit?: (event: SubmitEvent) => void;
  readonly onKeydown?: (event: KeyboardEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: readonly Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.title !== undefined) element.title = props.title;
  if (props.role !== undefined) element.setAttribute("role", props.role);
  if (props.id !== undefined) element.id = props.id;
  // Icon controls always expose the same name to pointer and keyboard users.
  if (props.title === undefined && typeof props.class === "string" && props.class.includes("icon-button") && props.aria?.label) element.title = props.aria.label;
  if (props.type !== undefined) element.setAttribute("type", props.type);
  if (props.name !== undefined) element.setAttribute("name", props.name);
  if (props.for !== undefined) element.setAttribute("for", props.for);
  if (props.placeholder !== undefined) element.setAttribute("placeholder", props.placeholder);
  if (props.rows !== undefined) element.setAttribute("rows", String(props.rows));
  if (props.value !== undefined) (element as HTMLInputElement).value = props.value;
  if (props.disabled !== undefined) (element as HTMLButtonElement).disabled = props.disabled;
  if (props.checked !== undefined) (element as HTMLInputElement).checked = props.checked;
  if (props.selected !== undefined) (element as HTMLOptionElement).selected = props.selected;
  if (props.open !== undefined) (element as HTMLDetailsElement).open = props.open;
  for (const [key, value] of Object.entries(props.data ?? {})) element.dataset[key] = value;
  for (const [key, value] of Object.entries(props.aria ?? {})) element.setAttribute(`aria-${key}`, value);
  if (props.onClick) element.addEventListener("click", props.onClick as EventListener);
  if (props.onInput) element.addEventListener("input", props.onInput);
  if (props.onChange) element.addEventListener("change", props.onChange);
  if (props.onSubmit) element.addEventListener("submit", props.onSubmit as EventListener);
  if (props.onKeydown) element.addEventListener("keydown", props.onKeydown as EventListener);
  append(element, children);
  return element;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue;
    parent.appendChild(typeof child === "string" || typeof child === "number"
      ? document.createTextNode(String(child))
      : child);
  }
}

/** Replaces all children of `parent`. */
export function replace(parent: Element, ...children: readonly Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/** Small uppercase mono label, used above lists and inside cards. */
export function label(text: string): HTMLElement {
  return h("span", { class: "label" }, text);
}

/** Stacked key/value for compact grids: mono label above the value. */
export function field(name: string, value: Child, options: { readonly mono?: boolean } = {}): HTMLElement {
  return h("div", { class: "kv" },
    h("span", { class: "label" }, name),
    h("span", { class: options.mono === false ? "kv-value" : "kv-value mono" }, value ?? "n/a"),
  );
}

/** Detail row: sans label on the left, mono value right-aligned, divider below. */
export function row(name: string, value: Child): HTMLElement {
  return h("div", { class: "detail-row" },
    h("span", { class: "detail-label" }, name),
    h("span", { class: "detail-value" }, value ?? "n/a"),
  );
}

/** Metric card: label with icon, large number, mono unit, and a mono caption. */
export function statCard(name: string, value: string, options: { readonly unit?: string; readonly caption?: string; readonly icon?: Node } = {}): HTMLElement {
  return h("div", { class: "stat" },
    h("div", { class: "stat-head" }, h("span", { class: "label" }, name), options.icon ?? null),
    h("div", { class: "stat-value" }, value, options.unit === undefined ? null : h("span", { class: "stat-unit" }, options.unit)),
    options.caption === undefined ? null : h("div", { class: "stat-caption" }, options.caption),
  );
}

/** Inline badge: icon plus mono text. */
export function badge(iconNode: Node, text: string, className = ""): HTMLElement {
  return h("span", { class: `badge ${className}`.trim() }, iconNode, h("span", {}, text));
}

/** Expandable structured data view for tool input/output of unknown shape. */
export function dataView(summary: string, value: unknown): HTMLElement {
  return h("details", { class: "data" },
    h("summary", {}, summary),
    h("pre", {}, formatData(value)),
  );
}

export function formatData(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function formatTime(iso: string | undefined): string {
  if (iso === undefined) return "n/a";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function shortId(id: string | undefined): string {
  return id === undefined ? "n/a" : id.slice(0, 8);
}

/** Reads a form control's trimmed value; empty means "not supplied". */
export function readField(form: HTMLFormElement, name: string): string | undefined {
  const control = form.elements.namedItem(name);
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) {
    const value = control.value.trim();
    return value === "" ? undefined : value;
  }
  return undefined;
}

/** Labelled input for inline forms. */
export function inputField(text: string, name: string, options: { readonly placeholder?: string; readonly required?: boolean } = {}): HTMLElement {
  const input = h("input", {
    name,
    type: "text",
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
  });
  if (options.required) input.required = true;
  return h("label", { class: "input" }, h("span", { class: "label" }, text), input);
}

/** Wraps an existing control (for example a dropdown trigger) with a mono label. */
export function control(text: string, element: HTMLElement): HTMLElement {
  return h("label", { class: "input" }, h("span", { class: "label" }, text), element);
}

/** Compact age for list rows: "now", "5m", "3h", "2d", then a short date. */
export function relativeTime(iso: string | undefined, now: Date = new Date()): string {
  if (iso === undefined) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((now.getTime() - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d`;
  return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
