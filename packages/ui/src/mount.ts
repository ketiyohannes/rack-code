/**
 * Mounts the renderer against an already-connected host client.
 *
 * This is split from `app.ts` so the interface is reusable by any
 * controller. The desktop bootstrap connects over the Electron preload
 * bridge, `apps/web` connects to a remote daemon over a WebSocket, and
 * neither difference is visible past this function — the client is just a
 * `HostClient`.
 *
 * Features are mounted explicitly here, mirroring the application's startup
 * composition: adding a panel means writing a `mount*` function and calling
 * it from this file. Features never discover each other; the only
 * cross-feature imports are explicit sub-views (settings hosts the accounts
 * pane, and the session view hosts inline run details).
 *
 * A Timeline window uses the same bundled page and the same client, but
 * mounts only the independent read-only viewer rather than chat state or
 * run controls.
 */
import type { HostClient } from "@rack/client";

import { Controller } from "./controller.js";
import { mountComposer } from "./features/composer.js";
import { mountNavigator } from "./features/navigator.js";
import { mountPullRequests } from "./features/pull-requests.js";
import { mountSessionView } from "./features/session-view.js";
import { mountSettings } from "./features/settings.js";
import { mountShell } from "./features/shell.js";
import { mountSnapshotWindow } from "./features/snapshot-window.js";
import { mountUsage } from "./features/usage.js";
import { mountWindowChrome } from "./features/window-chrome.js";
import { mountWorkbench } from "./features/workbench.js";
import { Store } from "./store.js";

export interface MountOptions {
  readonly root: HTMLElement;
  readonly host: HostClient;
  /** Query parameters; `view=timeline` selects the snapshot window. */
  readonly params: URLSearchParams;
}

export function mountApp({ root, host, params }: MountOptions): void {
  // The Windows/Linux menu strip drives Electron window actions through the
  // preload bridge. Without a shell behind the client those menu items can
  // do nothing, so a browser controller must not render a dead menu bar or
  // reserve layout space for one.
  if (host.hasShell) mountWindowChrome();
  if (params.get("view") === "timeline") {
    mountSnapshotWindow(root, host, params);
    return;
  }

  const store = new Store();
  const controller = new Controller(host, store);
  controller.loadPreferences();

  const regions = mountShell(root, store, controller);
  mountNavigator(regions.navigator, store, controller);
  const reviews = document.createElement("div");
  const usage = document.createElement("div");
  reviews.className = usage.className = "workspace-page-content";
  regions.page.append(reviews, usage);
  mountPullRequests(reviews, store, controller, host);
  mountUsage(usage, store, controller, host);
  mountSessionView(regions.session, regions.sessionHeader, store, controller);
  mountComposer(regions.composer, store, controller);
  mountWorkbench(regions.workbench, store, regions.isWorkbenchVisible, controller, host, regions.closeWorkbench);
  mountSettings(regions.overlay, store, controller);

  void controller.start();
}

/** The `#app` element, or a clear failure when the page is wrong. */
export function requireRoot(): HTMLElement {
  const root = document.getElementById("app");
  if (root === null) {
    throw new Error("Missing #app root element.");
  }
  return root;
}
