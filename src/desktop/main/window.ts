/**
 * Creates the chat or standalone Timeline window with a locked-down renderer.
 *
 * Security posture, per the architecture's desktop boundary:
 * - `contextIsolation` and `sandbox` on, `nodeIntegration` off: the renderer
 *   gets only the `window.harness` bridge from the preload script;
 * - navigation away from the bundled page and new windows are refused, so
 *   remote content can never inherit the bridge;
 * - the page itself ships a strict Content-Security-Policy (see index.html).
 */
import { BrowserWindow, nativeTheme, shell } from "electron";
import type { TimelineWindowRequest } from "../../contracts/desktop/transport.js";
import { performWindowAction } from "./window-actions.js";

export interface MainWindowOptions {
  readonly preloadPath: string;
  readonly indexPath: string;
  /** A standalone historical viewer, with the same sandbox and fixed bundled page. */
  readonly timeline?: TimelineWindowRequest;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: options.timeline === undefined ? 980 : 800,
    minHeight: 600,
    // Matches the renderer's light/dark surface so the window does not flash
    // the wrong color before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#121417" : "#f5f5f3",
    title: options.timeline === undefined ? "Rack" : "Timeline snapshot",
    // macOS: content extends under an inset title bar; the sidebar reserves
    // space for the window controls and acts as the drag region.
    titleBarStyle: process.platform === "darwin" ? (options.timeline ? "default" : "hiddenInset") : "hidden",
    ...(process.platform === "darwin" ? {} : { titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? "#121417" : "#f5f5f3",
      symbolColor: nativeTheme.shouldUseDarkColors ? "#eef0f2" : "#15171a", height: 36,
    } }),
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // The renderer supplies a themed menu strip. Keep macOS's global native
  // menu; Windows/Linux must not also render Electron's default menu bar.
  if (process.platform !== "darwin") window.setMenu(null);
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || process.platform === "darwin") return;
    const key = input.key.toLowerCase();
    const command = input.control || input.meta;
    const action = key === "f11" ? "fullscreen"
      : command && input.shift && key === "i" ? "devTools"
      : command && key === "r" ? "reload" : command && key === "w" ? "close"
      : command && key === "0" ? "resetZoom" : command && ["+", "="].includes(key) ? "zoomIn"
      : command && key === "-" ? "zoomOut" : undefined;
    if (action) { event.preventDefault(); performWindowAction(window, action); }
  });

  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    // External web links open in the user's browser, never inside the app.
    // Other schemes (file:, javascript:, custom protocols) are refused.
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  const target = options.timeline;
  void window.loadFile(options.indexPath, target === undefined ? {} : { query: {
    view: "timeline", scope: target.scope, contextId: target.contextId, checkpointId: target.checkpointId,
    ...(target.path === undefined ? {} : { path: target.path }),
  } });
  return window;
}
