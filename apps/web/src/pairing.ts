/**
 * The pairing screen: the one piece of interface the browser controller has
 * that the desktop app does not need.
 *
 * The desktop app's host is a sibling process, so it is simply there. A
 * browser controller has to be told which daemon to reach and prove it is
 * allowed to, and that cannot be done inside `@rack/ui` — the shared
 * interface starts from an already-connected client. This module therefore
 * owns everything before that point, and hands `main.ts` a validated
 * `ConnectionSettings`.
 *
 * It is written against the DOM directly, matching the framework-free style
 * of the rest of the interface.
 */
import { normalizeUrl, type ConnectionSettings } from "./connection.js";

export interface PairingOptions {
  readonly root: HTMLElement;
  /** Prefilled address, from a previous successful connection. */
  readonly initialUrl?: string;
  /** Shown above the form when a previous attempt failed. */
  readonly notice?: string;
  /**
   * Prefilled token. Supplied only when the previous attempt failed because
   * the daemon was unreachable rather than because it refused us, so the
   * user is not made to retype a token that was probably fine.
   */
  readonly prefillToken?: string;
}

export function requestPairing(options: PairingOptions): Promise<ConnectionSettings> {
  const { root } = options;
  root.textContent = "";

  const form = document.createElement("form");
  form.className = "pairing";
  form.noValidate = true;

  const heading = document.createElement("h1");
  heading.textContent = "Connect to a daemon";
  const explanation = document.createElement("p");
  explanation.className = "pairing-explanation";
  explanation.textContent =
    "Rack runs on the machine that holds your code. Enter that machine's daemon address and its pairing token, which you can read there with: rack-daemon --print-token";

  const error = document.createElement("p");
  error.className = "pairing-error";
  error.setAttribute("role", "alert");
  if (options.notice !== undefined) error.textContent = options.notice;

  const url = field("Daemon address", "url", "wss://daemon.example.net/rack");
  url.input.value = options.initialUrl ?? "";
  url.input.setAttribute("autocomplete", "url");

  const token = field("Pairing token", "token", "");
  token.input.type = "password";
  token.input.value = options.prefillToken ?? "";
  // The token is a device credential, not a password the browser should
  // offer to fill from a saved login.
  token.input.setAttribute("autocomplete", "off");
  token.input.spellcheck = false;

  const rememberLabel = document.createElement("label");
  rememberLabel.className = "pairing-remember";
  const remember = document.createElement("input");
  remember.type = "checkbox";
  const rememberText = document.createElement("span");
  rememberText.textContent = "Remember this token on this device";
  rememberLabel.append(remember, rememberText);

  const hint = document.createElement("p");
  hint.className = "pairing-hint";
  hint.textContent =
    "Leave this off on a shared or public computer: the token stays in this tab only and is cleared when the tab closes.";

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "pairing-submit";
  submit.textContent = "Connect";

  form.append(heading, explanation, error, url.wrapper, token.wrapper, rememberLabel, hint, submit);
  root.append(form);
  (url.input.value === "" ? url.input : token.input).focus();

  return new Promise((resolve) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const address = normalizeUrl(url.input.value);
      if ("error" in address) {
        error.textContent = address.error;
        url.input.focus();
        return;
      }
      if (token.input.value.trim() === "") {
        error.textContent = "Enter the pairing token.";
        token.input.focus();
        return;
      }
      resolve({ url: address.url, token: token.input.value.trim(), remember: remember.checked });
    });
  });
}

function field(label: string, id: string, placeholder: string): { wrapper: HTMLElement; input: HTMLInputElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "pairing-field";
  const element = document.createElement("label");
  element.htmlFor = `pairing-${id}`;
  element.textContent = label;
  const input = document.createElement("input");
  input.id = `pairing-${id}`;
  input.placeholder = placeholder;
  wrapper.append(element, input);
  return { wrapper, input };
}
