/** Small clipboard control shared by prose and tool views. Copies source text,
 * never rendered labels; clipboard denial is reported on the control itself. */
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";

export function copyButton(text: string, label = "Copy"): HTMLButtonElement {
  const button = h("button", { type: "button", class: "copy-button", title: label,
    aria: { label, live: "polite" } }, icon("copy"));
  // Clicking Copy should not collapse the selection the user was inspecting.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    button.disabled = true;
    let feedback: string;
    try {
      await navigator.clipboard.writeText(text);
      feedback = "Copied";
      replace(button, icon("check"));
    } catch {
      feedback = "Copy failed. Select the text and use Ctrl+C or Cmd+C.";
      replace(button, icon("x-circle"));
    }
    button.title = feedback;
    button.setAttribute("aria-label", feedback);
    setTimeout(() => {
      button.disabled = false;
      button.title = label;
      button.setAttribute("aria-label", label);
      replace(button, icon("copy"));
    }, 1800);
  });
  return button;
}
