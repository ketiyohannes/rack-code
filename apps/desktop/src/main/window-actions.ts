import { app, dialog, shell, type BrowserWindow } from "electron";
import type { WindowAction } from "@rack/contracts/transport";

/** Native effects behind the themed menu. The caller validates the action and
 * sender; no renderer paths, commands or external URLs are accepted here.
 * Closing/quitting still passes through the existing active-run exit policy.
 */
export function performWindowAction(window: BrowserWindow, action: WindowAction): void {
  const contents = window.webContents;
  switch (action) {
    case "undo": case "redo": case "cut": case "copy": case "paste": case "selectAll": contents[action](); break;
    case "reload": contents.reload(); break;
    case "devTools": contents.toggleDevTools(); break;
    case "zoomIn": contents.setZoomLevel(Math.min(3, contents.getZoomLevel() + 0.5)); break;
    case "zoomOut": contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - 0.5)); break;
    case "resetZoom": contents.setZoomLevel(0); break;
    case "fullscreen": window.setFullScreen(!window.isFullScreen()); break;
    case "close": window.close(); break;
    case "quit": app.quit(); break;
    case "help": void shell.openExternal("https://github.com/ketiyohannes/rack-code"); break;
    case "about": void dialog.showMessageBox(window, { type: "info", message: "Rack", detail: `Version ${app.getVersion()}`, buttons: ["OK"] }); break;
  }
}
