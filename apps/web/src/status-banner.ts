/**
 * Connection banner for the browser controller.
 *
 * The desktop app has no equivalent because its host cannot be "away" —
 * if the bridge is gone, so is the window. A remote daemon can be
 * unreachable for a minute while the interface stays perfectly usable to
 * look at, which is exactly when a user is most likely to be misled. The
 * banner exists to make that state visible rather than let stale run
 * statuses imply everything is fine.
 *
 * It appears only when something is worth saying: a healthy connection
 * shows nothing at all.
 */
import type { HostClient } from "@rack/client";

export interface ConnectionBannerOptions {
  /** Forget the stored token and return to pairing. */
  readonly onForget: () => void;
}

export function mountConnectionBanner(
  parent: HTMLElement,
  host: HostClient,
  options: ConnectionBannerOptions,
): () => void {
  const banner = document.createElement("div");
  banner.className = "connection-banner";
  banner.hidden = true;
  banner.setAttribute("role", "status");

  const message = document.createElement("span");
  const action = document.createElement("button");
  action.type = "button";
  action.textContent = "Disconnect";
  action.addEventListener("click", options.onForget);
  banner.append(message, action);
  parent.append(banner);

  const stop = host.onStatus((status) => {
    if (status.state === "online") {
      if (status.resume === "truncated") {
        // The gap in the event stream was too large to replay. Everything
        // on screen may be stale, and unlike a short blip this is not
        // self-correcting from events alone, so a reload is the honest fix.
        banner.hidden = false;
        banner.dataset["state"] = "stale";
        message.textContent = "Reconnected, but some updates were missed. Reload to refresh.";
        action.textContent = "Reload";
        action.onclick = () => window.location.reload();
        return;
      }
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.dataset["state"] = status.fatal === true ? "fatal" : status.state;
    action.textContent = "Disconnect";
    action.onclick = options.onForget;
    message.textContent = status.fatal === true
      ? status.detail ?? "The daemon refused this connection."
      : status.state === "connecting"
        ? "Reconnecting to the daemon…"
        : `Disconnected from the daemon. ${status.detail ?? ""} Retrying…`.trim();
  });

  return () => {
    stop();
    banner.remove();
  };
}
