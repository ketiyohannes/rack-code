/**
 * `ClientTransport` over the Electron preload bridge.
 *
 * This is the thinnest of the transports: the bridge already exposes exactly
 * the operations a client needs, so this file is mostly a re-shaping that
 * groups the shell operations under `shell`. It reports no connection status
 * on purpose — when this link dies, the renderer has died with it. A host
 * process that exits while the window lives is reported by Electron main as
 * an ordinary `host.status` event instead.
 */
import type { HarnessBridge } from "@rack/contracts";

import type { ClientTransport, ShellOperations } from "./transport.js";

declare global {
  interface Window {
    readonly harness: HarnessBridge;
  }
}

export function createBridgeTransport(bridge: HarnessBridge = window.harness): ClientTransport {
  const shell: ShellOperations = {
    selectDirectory: (options) => bridge.selectDirectory(options),
    selectFiles: (kind) => bridge.selectFiles(kind),
    openPath: (request) => bridge.openPath(request),
    listEditors: () => bridge.listEditors(),
    openInEditor: (request) => bridge.openInEditor(request),
    openTimelineWindow: (request) => bridge.openTimelineWindow(request),
    presentBrowser: (request) => bridge.presentBrowser(request),
    onBrowserAddressFocus: (listener) => bridge.onBrowserAddressFocus(listener),
  };
  return {
    invoke: (command, params) => bridge.invoke(command, params),
    onEvent: (listener) => bridge.onEvent(listener),
    shell,
  };
}
