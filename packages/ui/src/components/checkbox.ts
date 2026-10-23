/**
 * Custom checkbox that replaces the native `<input type="checkbox">`.
 *
 * The app never shows platform-default form controls; this renders the
 * app's own box and check/minus glyph. Accessibility follows the ARIA
 * checkbox pattern: a focusable `button` with `role="checkbox"` and
 * `aria-checked` of "true", "false", or "mixed" (the indeterminate state of
 * a "select all" control). Space and Enter toggle it, as a native button
 * activation does.
 *
 * `onToggle` receives the new checked value. A mixed checkbox becomes
 * checked when toggled, matching the native behavior.
 */
import { h } from "../dom.js";
import { icon } from "../icons.js";

export type CheckState = boolean | "mixed";

export interface Checkbox {
  readonly element: HTMLButtonElement;
  readonly checked: boolean;
  set(state: CheckState): void;
  setDisabled(disabled: boolean): void;
}

export function createCheckbox(options: { readonly label: string; readonly checked?: CheckState; readonly onToggle: (checked: boolean) => void }): Checkbox {
  let state: CheckState = options.checked ?? false;
  const element = h("button", { class: "checkbox", type: "button", role: "checkbox", aria: { label: options.label } });
  const render = () => {
    element.setAttribute("aria-checked", state === "mixed" ? "mixed" : String(state));
    element.replaceChildren(state === false ? "" : icon(state === "mixed" ? "minus" : "check"));
  };
  element.addEventListener("click", (event) => {
    // The checkbox often sits inside a clickable row; do not activate it too.
    event.stopPropagation();
    state = state !== true;
    render();
    options.onToggle(state);
  });
  render();
  return {
    element,
    get checked() { return state === true; },
    set(next) { state = next; render(); },
    setDisabled(disabled) { element.disabled = disabled; },
  };
}
