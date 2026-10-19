/**
 * Settings > Accounts: connect provider accounts and manage saved ones.
 *
 * - "Connect <provider> account" buttons come from `auth.providers`; nothing
 *   here knows provider names. A sign-in shows a card with its progress:
 *   waiting for the browser (with a link to reopen the sign-in page), a
 *   device code, or a code field when the provider asks for a pasted code.
 *   Finished sign-ins stay until dismissed so the outcome is visible.
 * - Saved accounts show display-safe fields only (`AccountView`). "Reconnect"
 *   signs in again for that account; selection affects future runs only.
 *
 * No credential or secret is typed into or shown by this pane. The provider
 * keeps the login in the account's own runtime-context directory.
 */
import type { AccountView, ConnectView } from "../../../contracts/desktop/index.js";
import type { Controller } from "../controller.js";
import { formatTime, h, replace, row } from "../dom.js";
import { icon } from "../icons.js";
import type { AppState, Store } from "../store.js";
import { accountLabel, availabilityBadge } from "./run-format.js";
import { openModal } from "../components/modal.js";

export function mountAccounts(root: HTMLElement, store: Store, controller: Controller): void {
  const count = h("span", { class: "count-wrap" });
  const connectButtons = h("div", { class: "connect-buttons" });
  const connecting = h("div", { class: "connect-list" });
  const diagnostics = h("div", { class: "connection-shortcuts" });
  const list = h("div", { class: "account-list" });

  root.append(
    h("header", { class: "settings-pane-header" },
      h("h3", {}, "Accounts ", count),
      h("p", {}, "Sign in with your own subscriptions. Credentials stay in each provider's own login store, isolated per account."),
    ),
    connectButtons,
    diagnostics,
    connecting,
    list,
  );

  store.watch((state) => [state.connectProviders, state.connects], (_slice, state) => {
    const busy = new Set(Object.values(state.connects)
      .filter((connect) => connect.status === "waiting")
      .map((connect) => connect.providerId));
    replace(connectButtons, ...state.connectProviders.map((provider) => h("button", {
      class: "connect-button",
      disabled: busy.has(provider.providerId),
      onClick: () => void controller.connectAccount(provider.providerId),
    },
      icon("plugs"),
      h("span", {}, `Connect ${provider.displayName} account`),
      busy.has(provider.providerId) ? icon("circle-notch", { className: "spin" }) : icon("arrow-right"),
    )));
    replace(connecting, ...Object.values(state.connects).map((connect) => renderConnect(connect, state, controller)));
  });

  store.watch((state) => state.connectProviders, (_slice, state) => {
    replace(diagnostics, h("span", { class: "connection-shortcuts-label" }, "Connection details"),
      ...state.connectProviders.map((provider) => h("button", {
        class: "quiet-button", type: "button", onClick: () => openDiagnostic(provider.providerId, undefined, store, controller),
      }, provider.displayName, icon("arrow-right"))));
  });

  store.watch((state) => [state.accounts, state.highlightAccountId, state.connects], (_slice, state) => {
    replace(count, h("span", { class: "count" }, String(state.accounts.length)));
    if (state.accounts.length === 0) {
      replace(list, h("div", { class: "empty-card" }, icon("user-circle"), h("span", {}, "No accounts yet. Connect one above.")));
      return;
    }
    const providers = [...new Set(state.accounts.map((account) => account.providerId))].sort();
    replace(list, ...providers.map((providerId) => h("div", { class: "provider-group" },
      h("span", { class: "label" }, providerName(state, providerId)),
      ...state.accounts
        .filter((account) => account.providerId === providerId)
        .map((account) => renderAccount(account, state, controller, store)),
    )));
    if (state.highlightAccountId !== undefined) {
      list.querySelector(`[data-account-id="${CSS.escape(state.highlightAccountId)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  });
}

/** Progress card for one sign-in. */
function renderConnect(connect: ConnectView, state: AppState, controller: Controller): HTMLElement {
  const name = providerName(state, connect.providerId);
  const reconnect = connect.targetAccountId !== undefined;
  const title = connect.status === "waiting"
    ? `${reconnect ? "Reconnecting" : "Connecting"} ${name} account`
    : connect.status === "completed"
      ? `${name} account ${connect.reconnected ? "reconnected" : "connected"}`
      : connect.status === "cancelled" ? "Sign-in cancelled" : "Sign-in failed";

  const body: Node[] = [];
  if (connect.status === "waiting") {
    body.push(h("p", { class: "form-note" }, connect.url === undefined
      ? "Starting sign-in..."
      : connect.urlOpenedByProvider
        ? "Finish signing in on the page that opened in your browser."
        : "Finish signing in in your browser. The page opened automatically."));
    if (connect.userCode !== undefined) {
      body.push(h("div", { class: "device-code" }, h("span", { class: "label" }, "Code"), h("span", { class: "device-code-value" }, connect.userCode)));
    }
    if (connect.needsCode) body.push(renderCodeForm(connect, controller));
  } else if (connect.status === "failed" && connect.error !== undefined) {
    body.push(h("p", { class: "form-note" }, connect.error));
  } else if (connect.status === "completed" && connect.identityChanged) {
    body.push(h("p", { class: "form-note" }, "You signed in as a different account, so it was saved separately."));
  }

  const actions: Node[] = [];
  if (connect.status === "waiting") {
    if (connect.url !== undefined) {
      const url = connect.url;
      actions.push(h("button", { class: "button button-small", onClick: () => controller.openExternal(url) }, "Open sign-in page"));
    }
    actions.push(h("button", { class: "button button-small", onClick: () => void controller.cancelConnect(connect.connectId) }, "Cancel"));
  } else {
    if (connect.status !== "completed") {
      actions.push(h("button", {
        class: "button button-small",
        onClick: () => {
          controller.dismissConnect(connect.connectId);
          void controller.connectAccount(connect.providerId, connect.targetAccountId);
        },
      }, "Try again"));
    }
    actions.push(h("button", { class: "button button-small", onClick: () => controller.dismissConnect(connect.connectId) }, "Dismiss"));
  }

  return h("div", { class: `connect-card connect-${connect.status}` },
    h("div", { class: "account-head" },
      h("span", { class: "icon-tile" }, connect.status === "waiting"
        ? icon("circle-notch", { className: "spin" })
        : icon(connect.status === "completed" ? "check-circle" : connect.status === "failed" ? "warning-circle" : "x-circle")),
      h("span", { class: "tool-text" }, h("span", { class: "tool-name" }, title)),
    ),
    ...body,
    h("div", { class: "card-actions" }, ...actions),
  );
}

function renderCodeForm(connect: ConnectView, controller: Controller): HTMLFormElement {
  const input = h("input", { type: "text", placeholder: "Paste the code from the sign-in page", aria: { label: "Authorization code" } });
  return h("form", { class: "input-with-button", onSubmit: (event) => {
    event.preventDefault();
    const code = input.value.trim();
    if (code !== "") void controller.submitConnectCode(connect.connectId, code);
  } }, input, h("button", { class: "button button-primary", type: "submit" }, "Submit"));
}

function renderAccount(account: AccountView, state: AppState, controller: Controller, store: Store): HTMLElement {
  const highlighted = state.highlightAccountId === account.id;
  const reconnecting = Object.values(state.connects).some((connect) =>
    connect.status === "waiting" && connect.targetAccountId === account.id);
  return h("div", {
    class: ["account", account.selected ? "selected" : "", highlighted ? "highlight" : ""].join(" ").trim(),
    data: { accountId: account.id },
  },
    h("div", { class: "account-head" },
      h("span", { class: "icon-tile" }, icon("user-circle")),
      h("span", { class: "tool-text" },
        h("span", { class: "tool-name" }, accountLabel(account)),
        h("span", { class: "tool-meta" }, [account.identity.email ?? account.identity.providerAccountId, account.availabilityReason]
          .filter((part) => part !== undefined).join(" / ")),
      ),
      account.selected ? h("span", { class: "chip chip-strong" }, icon("check"), "Selected") : null,
    ),
    h("div", { class: "detail-rows" },
      row("Status", availabilityBadge(account.availability)),
      account.quotaResetAt === undefined ? null : row("Quota resets", formatTime(account.quotaResetAt)),
      row("Last used", formatTime(account.lastUsedAt)),
      row("Active runs", String(account.activeAttempts)),
    ),
    h("div", { class: "card-actions" },
      account.selected ? null : h("button", {
        class: "icon-button", type: "button",
        title: "Select account for future runs", aria: { label: "Select account for future runs" },
        onClick: () => void controller.selectAccount(account.providerId, account.id),
      }, icon("check")),
      h("button", {
        class: account.availability === "reauth_required" ? "icon-button icon-button-primary" : "icon-button", type: "button",
        title: "Reconnect account", aria: { label: "Reconnect account" },
        disabled: reconnecting,
        onClick: () => void controller.connectAccount(account.providerId, account.id),
      }, icon("arrow-clockwise")),
      h("button", { class: "icon-button", type: "button", title: "Connection details", aria: { label: "Connection details" },
        onClick: () => openDiagnostic(account.providerId, account.id, store, controller),
      }, icon("info")),
    ),
  );
}

/** Only normalized, allowlisted observations reach this view. Text nodes keep
 * executable paths literal, and timestamps make the point-in-time scope clear.
 */
function renderDiagnostic(providerId: string, accountId: string | undefined, state: AppState): HTMLElement {
  const check = state.providerDiagnostics[JSON.stringify([providerId, accountId ?? null])];
  const result = check?.result;
  return h("div", { class: "provider-diagnostic" },
    h("div", { role: "status", aria: { live: "polite" } },
      check?.pending ? h("p", { class: "form-note" }, "Checking the local CLI. Each startup step has a 10-second timeout.") : null,
      check?.error ? h("p", { class: "form-note" }, check.error) : null,
      result ? h("div", { class: "detail-rows" },
        row("Check", result.status === "ready" ? "Passed" : "Needs attention"),
        h("p", { class: "form-note" }, result.message),
        result.executable ? row("Executable", result.executable) : null,
        result.version ? row("Version", result.version) : null,
        row("Sign-in", result.authentication === "signed_in" ? "Saved sign-in found" : result.authentication === "signed_out" ? "Signed out" : "Not checked"),
        row("Checked", formatTime(result.checkedAt)),
      ) : null,
    ),
  );
}

/** An on-demand drawer keeps technical details out of the account list. Its
 * subscription ends on close; an already-running read-only check may finish
 * in the controller cache and is visible when reopened. Focus stays in the
 * modal and returns to the trigger without closing the underlying Settings.
 */
function openDiagnostic(providerId: string, accountId: string | undefined, store: Store, controller: Controller): void {
  const name = providerName(store.get(), providerId);
  const account = store.get().accounts.find((entry) => entry.id === accountId);
  const result = h("div", {});
  const run = h("button", { class: "button button-small", type: "button",
    onClick: () => void controller.diagnoseProvider(providerId, accountId),
  }, "Test connection");
  const content = h("div", { class: "modal-body diagnostic-drawer-body" },
    h("p", { class: "diagnostic-description" }, account ? accountLabel(account) : `${name} installation`),
    h("p", { class: "form-note" }, "Check the local installation and connection when something isn't working. This does not start a model request."),
    h("div", { class: "card-actions" }, run), result,
  );
  const key = JSON.stringify([providerId, accountId ?? null]);
  const unsubscribe = store.watch((state) => state.providerDiagnostics[key], (check, state) => {
    run.disabled = check?.pending === true;
    run.textContent = check?.pending ? "Checking..." : check?.result ? "Check again" : "Test connection";
    replace(result, renderDiagnostic(providerId, accountId, state));
  });
  openModal({ title: `${name} connection`, className: "diagnostic-drawer", content, onClose: unsubscribe });
}

function providerName(state: AppState, providerId: string): string {
  return state.connectProviders.find((provider) => provider.providerId === providerId)?.displayName ?? providerId;
}
