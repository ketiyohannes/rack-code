import { mountPullRequests } from "./features/pull-requests.js";
import { mountUsage } from "./features/usage.js";
/**
 * Renderer bootstrap: builds the store, controller, and feature panels, then
 * connects to the host.
 *
 * Features are mounted explicitly here, mirroring the application's startup
 * composition: adding a panel means writing a `mount*` function and calling
 * it from this file. Features never discover each other; the only
 * cross-feature imports are explicit sub-views (settings hosts the accounts
 * pane, and the session view hosts inline run details).
 * A Timeline window uses the same bundled page and bridge, but mounts only
 * the independent read-only viewer rather than chat state or run controls.
 */
import { Controller } from "./controller.js";
import { mountComposer } from "./features/composer.js";
import { mountNavigator } from "./features/navigator.js";
import { mountSessionView } from "./features/session-view.js";
import { mountSettings } from "./features/settings.js";
import { mountShell } from "./features/shell.js";
import { mountWorkbench } from "./features/workbench.js";
import { createHostClient } from "./host-client.js";
import { Store } from "./store.js";
import { mountSnapshotWindow } from "./features/snapshot-window.js";
import { mountWindowChrome } from "./features/window-chrome.js";

const root = document.getElementById("app");
if (root === null) {
  throw new Error("Missing #app root element.");
}

const params = new URLSearchParams(window.location.search);
mountWindowChrome();
if (params.get("view") === "timeline") {
  mountSnapshotWindow(root, createHostClient(), params);
} else {
  const store = new Store();
  const host = createHostClient();
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
  mountWorkbench(regions.workbench, store, regions.isWorkbenchVisible, controller, host);
  mountSettings(regions.overlay, store, controller);

  void controller.start();
}
