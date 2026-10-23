/**
 * Browser controller bootstrap.
 *
 * Structurally this is the desktop bootstrap plus the two things a remote
 * connection forces it to deal with: deciding *which* host to talk to, and
 * surviving that host becoming unreachable.
 *
 * The sequence is: load saved settings or ask for them, open a WebSocket
 * transport, wait for the daemon to accept the pairing token, then mount the
 * shared interface. Mounting is deliberately deferred until the handshake
 * succeeds — showing the full interface and then discovering the token was
 * refused would leave the user looking at an empty workspace with no
 * explanation.
 *
 * Two failures are treated very differently, because conflating them loses
 * the user something real:
 *
 * - **Refused** (bad token, unsupported protocol) is final. The token is
 *   forgotten and pairing is asked for again with the daemon's reason.
 * - **Unreachable** (asleep laptop, dropped network) is not. The token is
 *   kept, and the user is offered a retry. Wiping a perfectly good token
 *   because a VPS was rebooting would be its own small outage.
 *
 * Once mounted, connection state is shown in a banner rather than by
 * tearing the interface down. The transport queues commands and resumes the
 * event stream across a blip, so the right response is to say so and keep
 * the user's context.
 */
import { createHostClient, createWebSocketTransport, type ConnectionStatus } from "@rack/client";
import { mountApp, requireRoot } from "@rack/ui/mount";

import { clientId, forgetToken, loadSettings, saveSettings, type ConnectionSettings } from "./connection.js";
import { requestPairing } from "./pairing.js";
import { mountConnectionBanner } from "./status-banner.js";

/** How long a first connection may take before the user is offered a retry. */
const CONNECT_TIMEOUT_MS = 15_000;

const root = requireRoot();
const params = new URLSearchParams(window.location.search);

/** Replaces the page with a progress line while the handshake runs. */
function showConnecting(url: string): void {
  root.textContent = "";
  const panel = document.createElement("div");
  panel.className = "pairing pairing-progress";
  const heading = document.createElement("h1");
  heading.textContent = "Connecting…";
  const detail = document.createElement("p");
  detail.className = "pairing-explanation";
  detail.textContent = url;
  panel.append(heading, detail);
  root.append(panel);
}

async function start(initial: ConnectionSettings): Promise<void> {
  let settings = initial;
  for (;;) {
    showConnecting(settings.url);
    const transport = createWebSocketTransport({
      url: settings.url,
      token: settings.token,
      clientId: clientId(),
    });
    const host = createHostClient(transport);
    const outcome = await firstOutcome(host.onStatus.bind(host));

    if (outcome.state === "online") {
      saveSettings(settings);
      root.textContent = "";
      mountApp({ root, host, params });
      mountConnectionBanner(document.body, host, {
        onForget: () => {
          forgetToken();
          transport.close?.();
          window.location.reload();
        },
      });
      return;
    }

    transport.close?.();
    // Only a daemon that actively refused us invalidates the token.
    if (outcome.fatal === true) forgetToken();
    settings = await requestPairing({
      root,
      initialUrl: settings.url,
      ...(outcome.fatal === true
        ? { notice: outcome.detail ?? "The daemon refused this pairing token." }
        : { notice: `Could not reach the daemon. ${outcome.detail ?? ""}`.trim() }),
      ...(outcome.fatal === true ? {} : { prefillToken: settings.token }),
    });
  }
}

/**
 * Resolves on the first settled outcome of a connection attempt: `online`
 * once the daemon has welcomed us, or `offline` when the attempt was
 * refused outright or took too long. Ordinary retryable failures are not
 * settled immediately, so a slow network gets the full timeout rather than
 * being reported as a rejection on the first failed socket.
 */
function firstOutcome(
  onStatus: (listener: (status: ConnectionStatus) => void) => () => void,
): Promise<ConnectionStatus> {
  return new Promise((resolve) => {
    let last: ConnectionStatus | undefined;
    const timer = setTimeout(() => {
      stop();
      resolve(last?.state === "offline" ? last : { state: "offline", detail: "The daemon did not respond." });
    }, CONNECT_TIMEOUT_MS);
    const stop = onStatus((status) => {
      last = status;
      if (status.state !== "online" && status.fatal !== true) return;
      clearTimeout(timer);
      stop();
      resolve(status);
    });
  });
}

// Wrapped rather than written as a top-level await because the bundle is
// an IIFE, matching the desktop renderer. A bootstrap failure is shown on
// the page: an unhandled rejection here would leave a blank document.
void (async () => {
  try {
    await start(loadSettings() ?? (await requestPairing({ root })));
  } catch (error) {
    root.textContent = "";
    const panel = document.createElement("div");
    panel.className = "pairing";
    const heading = document.createElement("h1");
    heading.textContent = "Rack could not start";
    const detail = document.createElement("p");
    detail.className = "pairing-explanation";
    detail.textContent = error instanceof Error ? error.message : String(error);
    panel.append(heading, detail);
    root.append(panel);
  }
})();
