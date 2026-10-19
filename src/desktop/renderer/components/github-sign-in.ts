/**
 * GitHub account dialog with browser sign-in.
 *
 * Used by the Pull Requests inbox (Accounts) and by repository connections.
 * The dialog never asks for a token. "Continue with browser" asks the host to
 * start `gh auth login --web`, copies the one-time code, and opens GitHub's
 * device page. The dialog then waits until gh reports the outcome.
 *
 * Lifecycle: closing the dialog while a sign-in is waiting cancels it, so a
 * dismissed dialog never leaves gh polling in the background. Late outcomes
 * from a cancelled or replaced attempt are ignored via `attempt`.
 */
import type { AccountLogin, ReviewAccount } from "../../../features/pull-requests/index.js";
import type { Controller } from "../controller.js";
import type { HostClient } from "../host-client.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openModal } from "./modal.js";

export interface GitHubSignInOptions {
  readonly host: HostClient;
  readonly controller: Controller;
  /** Preselected hostname; GitHub Enterprise hosts can be typed when `hostEditable` is set. */
  readonly hostname?: string;
  readonly hostEditable?: boolean;
  /** Already connected identities, listed for reference. */
  readonly accounts?: readonly ReviewAccount[];
  /** Rescans gh logins; offered for sign-ins done outside Rack. */
  readonly onRefresh?: () => Promise<void>;
  readonly onSignedIn: (account: ReviewAccount) => void | Promise<void>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const sourceLabel = (account: ReviewAccount) => account.source === "cli" ? "GitHub CLI" : "Environment";

export function openGitHubSignIn(options: GitHubSignInOptions): void {
  const { host, controller } = options;
  let login: AccountLogin | undefined;
  let attempt = 0;
  const hostname = h("input", { value: options.hostname ?? "github.com", placeholder: "github.com", aria: { label: "GitHub hostname" } });
  hostname.disabled = options.hostEditable !== true;
  const body = h("div", { class: "modal-body review-form github-sign-in" });
  const modal = openModal({
    title: "GitHub accounts",
    content: body,
    onClose: () => {
      attempt++;
      if (login) void host.call("reviews.accountLoginCancel", { loginId: login.loginId }).catch(() => undefined);
      login = undefined;
    },
  });

  function accountList(): HTMLElement | null {
    const accounts = options.accounts ?? [];
    if (!accounts.length) return null;
    return h("div", { class: "pr-connected-accounts" }, ...accounts.map((account) => h("div", { class: "pr-connected-account" },
      icon("github-logo"), h("strong", {}, account.login), h("span", { class: "note" }, `${account.host} · ${sourceLabel(account)}`))));
  }

  function renderStart(error?: string): void {
    const start = h("button", { class: "button button-primary github-sign-in-start", type: "button", onClick: () => void begin() },
      icon("github-logo"), h("span", {}, "Continue with browser"));
    const actions: Node[] = [];
    if (options.onRefresh) {
      const refresh = options.onRefresh;
      actions.push(h("button", { class: "icon-button", type: "button", title: "Refresh accounts", aria: { label: "Refresh accounts" }, onClick: async () => { await refresh(); modal.close(); } }, icon("arrow-clockwise")));
    }
    actions.push(start);
    replace(body,
      accountList(),
      options.hostEditable ? h("label", {}, "Hostname", hostname) : null,
      h("p", { class: "note" }, "GitHub opens in your browser. Enter the code shown here to authorize. The GitHub CLI keeps you signed in, so the account stays connected after restart."),
      error ? h("p", { class: "error-line", role: "alert" }, error) : null,
      h("div", { class: "modal-actions" }, ...actions));
    start.focus();
  }

  function renderWaiting(current: AccountLogin, copied: boolean): void {
    const copy = h("button", { class: "icon-button", type: "button", title: "Copy code", aria: { label: "Copy code" }, onClick: () => void copyCode(current, true) }, icon(copied ? "check" : "copy"));
    replace(body,
      h("p", { class: "note" }, copied ? `Paste this code on ${current.host} to authorize. It is already on your clipboard.` : `Enter this code on ${current.host} to authorize.`),
      h("div", { class: "device-code github-device-code" },
        h("span", { class: "device-code-value", aria: { label: "One-time code" } }, current.userCode), copy),
      h("p", { class: "github-sign-in-waiting note", role: "status", aria: { live: "polite" } }, icon("circle-notch", { className: "spin" }), h("span", {}, "Waiting for authorization in your browser…")),
      h("div", { class: "modal-actions" },
        h("button", { class: "button button-small", type: "button", onClick: () => modal.close() }, "Cancel"),
        h("button", { class: "button button-small button-primary", type: "button", onClick: () => controller.openExternal(current.verificationUrl) }, icon("arrow-up-right"), h("span", {}, "Open GitHub"))));
  }

  async function copyCode(current: AccountLogin, rerender: boolean): Promise<void> {
    try {
      await navigator.clipboard.writeText(current.userCode);
      if (rerender && login === current) renderWaiting(current, true);
    } catch { /* Clipboard access can be denied; the code remains visible to type. */ }
  }

  async function begin(): Promise<void> {
    const identity = ++attempt;
    const target = hostname.value.trim().toLowerCase() || "github.com";
    replace(body, h("p", { class: "github-sign-in-waiting note", role: "status" }, icon("circle-notch", { className: "spin" }), h("span", {}, "Starting sign-in…")));
    let current: AccountLogin;
    try { current = await host.call("reviews.accountLoginBegin", { host: target }); }
    catch (error) { if (identity === attempt) renderStart(message(error)); return; }
    if (identity !== attempt) { void host.call("reviews.accountLoginCancel", { loginId: current.loginId }).catch(() => undefined); return; }
    login = current;
    renderWaiting(current, false);
    // Copy first so the code is ready to paste when the browser page appears.
    await copyCode(current, true);
    controller.openExternal(current.verificationUrl);
    let outcome;
    try { outcome = await host.call("reviews.accountLoginFinish", { loginId: current.loginId }); }
    catch (error) { outcome = { status: "failed" as const, error: message(error) }; }
    if (identity !== attempt) return;
    login = undefined;
    if (outcome.status === "completed") { modal.close(); await options.onSignedIn(outcome.account); }
    else renderStart(outcome.status === "failed" ? outcome.error : "Sign-in was cancelled.");
  }

  renderStart();
}
