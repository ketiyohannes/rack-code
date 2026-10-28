import { DesktopEditors } from "./editors.js";
/**
 * Electron main process: desktop lifecycle and the privileged IPC boundary.
 *
 * Main deliberately holds no application state. It
 * 1. forks the execution host utility process (which composes the app),
 * 2. opens the window,
 * 3. validates every renderer request before relaying it to the host,
 * 4. broadcasts host events to all windows, and
 * 5. shows native dialogs (the folder picker) on the renderer's behalf.
 *
 * Exit policy (default stop-on-exit from the architecture): quitting while
 * runs are active asks for confirmation, then asks the host to cancel them
 * and wait briefly for terminal states to be persisted before terminating
 * it. Closing the last window quits the app on every platform, because the
 * host must not keep working invisibly until background mode exists.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";

import {
  isHostCommand,
  validateCommandParams,
} from "@rack/contracts/commands";
import type { HostEvent } from "@rack/contracts/events";
import { ATTACHMENT_KINDS, IPC_CHANNELS, type AttachmentKind, type CommandResponse, type OpenPathResult } from "@rack/contracts/transport";
import { boolean, integer, ContractValidationError, object, oneOf, optional, text } from "@rack/contracts/validation";
import { HostProcess } from "./host-process.js";
import { classifyOpenPath } from "./open-path.js";
import { createMainWindow } from "./window.js";
import { SharedBrowser } from "./shared-browser.js";
import { WINDOW_ACTIONS } from "@rack/contracts/transport";
import { performWindowAction } from "./window-actions.js";
import { adoptLegacyUserData } from "./user-data.js";

/** How long quitting waits for cancelled runs to record a terminal state. */
const editors = new DesktopEditors();
const SHUTDOWN_TIMEOUT_MS = 10_000;
// Before the lock below, which writes into the user-data directory: renderer
// preferences stored under the product's former name move across first.
adoptLegacyUserData(app.getPath("userData"));
// Recovery assumes one live owner of persisted execution. A second launch of
// the same desktop profile focuses its owner rather than recovering its runs.
const ownsInstance = app.requestSingleInstanceLock();
app.on("second-instance", () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window === undefined) openWindow();
  else { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
});

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const paths = {
  host: join(bundleDirectory, "host.mjs"),
  preload: join(bundleDirectory, "preload.cjs"),
  index: join(bundleDirectory, "renderer", "index.html"),
  /** Window icon on Linux and the Dock icon in development; packaged macOS and Windows use the bundle icon. */
  icon: join(bundleDirectory, "icon.png"),
};

let host: HostProcess | undefined;
let quitConfirmed = false;
let quitInProgress = false;
const sharedBrowser = new SharedBrowser();

function broadcast(event: HostEvent): void {
  if (event.type === "sessions.removed") sharedBrowser.close(event.sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}

function openWindow(): void {
  createMainWindow({ preloadPath: paths.preload, indexPath: paths.index, iconPath: paths.icon });
}

/**
 * Only the bundled page may call the bridge. This rejects requests from any
 * frame that somehow navigated elsewhere, even though navigation is blocked.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith("file://") && fileURLToPath(url) === paths.index;
}

async function handleInvoke(
  event: IpcMainInvokeEvent,
  command: unknown,
  params: unknown,
): Promise<CommandResponse> {
  if (!isTrustedSender(event)) {
    return { ok: false, error: { code: "invalid_input", name: "UntrustedSenderError", message: "Request rejected." } };
  }
  if (!isHostCommand(command)) {
    return { ok: false, error: { code: "unknown_command", name: "UnknownCommandError", message: `Unknown command '${String(command)}'.` } };
  }
  try {
    validateCommandParams(command, params);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      return { ok: false, error: { code: "invalid_input", name: error.name, message: error.message } };
    }
    throw error;
  }
  if (host === undefined) {
    return { ok: false, error: { code: "host_unavailable", name: "HostUnavailableError", message: "The execution host is not running." } };
  }
  await host.ready;
  return host.request(command, params);
}

const validateSelectDirectory = object({
  title: optional(text({ maxLength: 200 })),
  defaultPath: optional(text({ maxLength: 4096 })),
});

const validateBrowserPresentation = object({
  sessionId: optional(text({ maxLength: 200 })), visible: boolean,
  bounds: optional(object({ x: integer(0, 20_000), y: integer(0, 20_000), width: integer(0, 20_000), height: integer(0, 20_000) })),
});

/**
 * Shows the native folder picker as a sheet/modal of the calling window.
 * Returns the chosen absolute path, or `undefined` on cancel or rejection.
 * Only a path string crosses back to the renderer; no filesystem access is
 * granted by this call.
 */
async function handleSelectDirectory(event: IpcMainInvokeEvent, options: unknown): Promise<string | undefined> {
  if (!isTrustedSender(event)) return undefined;
  let parsed: ReturnType<typeof validateSelectDirectory>;
  try {
    parsed = validateSelectDirectory(options ?? {}, "");
  } catch {
    return undefined;
  }
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Choose",
    ...(parsed.title === undefined ? {} : { title: parsed.title, message: parsed.title }),
    ...(parsed.defaultPath === undefined ? {} : { defaultPath: parsed.defaultPath }),
  };
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = parent === null
    ? await dialog.showOpenDialog(dialogOptions)
    : await dialog.showOpenDialog(parent, dialogOptions);
  return result.canceled ? undefined : result.filePaths[0];
}

const validateOpenPath = object({
  path: text({ maxLength: 4096 }),
  base: optional(text({ maxLength: 4096 })),
});

const validateTimelineWindow = object({
  scope: oneOf(["project", "session"]),
  contextId: text({ maxLength: 200 }), checkpointId: text({ maxLength: 200 }),
  path: optional(text({ maxLength: 4096 })),
});

/**
 * Opens only the bundled viewer and only after the host resolves the selected
 * checkpoint. No renderer-provided URL, file path or Git revision is loaded.
 * Each viewer stays pinned to its own context when the main window navigates.
 */
async function handleTimelineWindow(event: IpcMainInvokeEvent, request: unknown): Promise<CommandResponse<null>> {
  if (!isTrustedSender(event)) return { ok: false, error: { code: "invalid_input", name: "UntrustedSenderError", message: "Request rejected." } };
  let target: ReturnType<typeof validateTimelineWindow>;
  try { target = validateTimelineWindow(request, ""); }
  catch { return { ok: false, error: { code: "invalid_input", name: "InvalidTimelineWindow", message: "Invalid snapshot window request." } }; }
  const result = await handleInvoke(event, "timeline.snapshot", { scope: target.scope, contextId: target.contextId, checkpointId: target.checkpointId });
  if (!result.ok) return result;
  createMainWindow({ preloadPath: paths.preload, indexPath: paths.index, iconPath: paths.icon, timeline: target });
  return { ok: true, value: null };
}

const FILE_FILTERS: Record<AttachmentKind, Electron.FileFilter> = {
  images: { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tif", "tiff", "heic", "avif"] },
  documents: { name: "Documents", extensions: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "csv", "xls", "xlsx", "ppt", "pptx"] },
  code: { name: "Code and text", extensions: ["txt", "md", "json", "jsonl", "csv", "yaml", "yml", "toml", "xml", "log", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cpp", "cs", "swift", "kt", "html", "css", "sql", "sh", "ipynb"] },
  all: { name: "All files", extensions: ["*"] },
};

/** Selects regular files without exposing filesystem APIs or accepting arbitrary dialog options. */
async function handleSelectFiles(event: IpcMainInvokeEvent, kind: unknown): Promise<readonly string[]> {
  if (!isTrustedSender(event)) return [];
  const parsed = oneOf(ATTACHMENT_KINDS)(kind, "kind");
  const options: Electron.OpenDialogOptions = {
    title: "Attach files", buttonLabel: "Attach", properties: ["openFile", "multiSelections"],
    filters: parsed === "all" ? [FILE_FILTERS.all] : [FILE_FILTERS[parsed], FILE_FILTERS.all],
  };
  const parent = BrowserWindow.fromWebContents(event.sender);
  const result = parent === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options);
  return result.canceled ? [] : result.filePaths;
}

/**
 * Opens a path the user clicked (in a reply, tool activity, or diff).
 * Paths are untrusted text from agent output: `classifyOpenPath` resolves
 * them against the project folder and reveals anything that could execute
 * in Finder instead of opening it. Only the outcome crosses back.
 */
async function handleOpenPath(event: IpcMainInvokeEvent, request: unknown): Promise<OpenPathResult> {
  if (!isTrustedSender(event)) return "invalid";
  let parsed: ReturnType<typeof validateOpenPath>;
  try {
    parsed = validateOpenPath(request, "");
  } catch {
    return "invalid";
  }
  const action = await classifyOpenPath(parsed.path, parsed.base);
  if (action === undefined) return "invalid";
  if (action.kind === "missing") return "missing";
  if (action.kind === "reveal") {
    shell.showItemInFolder(action.path);
    return "revealed";
  }
  // openPath resolves with an error message, or "" on success.
  const failure = await shell.openPath(action.path);
  if (failure !== "") {
    shell.showItemInFolder(action.path);
    return "revealed";
  }
  return "opened";
}

/**
 * Confirms quitting when runs are active, then stops them through the host.
 * Returns false when the user chose to keep working.
 */
async function stopHostForQuit(current: HostProcess): Promise<boolean> {
  const active = await quitDeadline(current.request("runs.active", {}), 1500);
  const count = active?.ok && Array.isArray(active.value) ? active.value.length : 0;
  if (count > 0 || active === undefined || !active.ok) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Stop runs and quit", "Keep working"],
      defaultId: 1,
      cancelId: 1,
      message: active === undefined || !active.ok ? "The execution host is not responding." : count === 1 ? "1 run is active." : `${count} runs are active.`,
      detail: "Quitting cancels active agent runs and waits briefly for them to record their final state. Partial output is kept.",
    });
    if (response !== 0) {
      return false;
    }
  }
  // Interactive terminals also need orderly shutdown when no model run is active.
  await quitDeadline(current.shutdown(SHUTDOWN_TIMEOUT_MS), SHUTDOWN_TIMEOUT_MS);
  current.kill();
  sharedBrowser.shutdown();
  return true;
}

/** Includes host acknowledgments and optional cleanup in a finite quit budget. */
async function quitDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation.catch(() => undefined), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

app.on("before-quit", (event) => {
  if (quitConfirmed || host === undefined || !host.isRunning) {
    return;
  }
  event.preventDefault();
  if (quitInProgress) return;
  quitInProgress = true;
  const current = host;
  void stopHostForQuit(current).then((stopped) => {
    quitInProgress = false;
    if (stopped) {
      quitConfirmed = true;
      app.quit();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      // The quit came from closing the last window; reopen it so the user
      // is not left with an invisible app that still owns active runs.
      openWindow();
    }
  });
});

app.on("window-all-closed", () => app.quit());

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    openWindow();
  }
});

void app.whenReady().then(() => {
  if (!ownsInstance) { app.quit(); return; }
  // A packaged app takes its Dock icon from the bundle (icon.icns); an
  // unpackaged run would otherwise show Electron's.
  if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(paths.icon);
  ipcMain.handle(IPC_CHANNELS.windowAction, (event, action: unknown) => {
    if (!isTrustedSender(event)) return;
    const parsed = oneOf(WINDOW_ACTIONS)(action, "action");
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner !== null) performWindowAction(owner, parsed);
  });
  ipcMain.handle(IPC_CHANNELS.windowTheme, (event, colors: unknown) => {
    if (!isTrustedSender(event) || process.platform === "darwin") return;
    const parsed = object({ background: text({ maxLength: 7 }), foreground: text({ maxLength: 7 }) })(colors, "colors");
    if (![parsed.background, parsed.foreground].every((color) => /^#[0-9a-f]{6}$/i.test(color))) return;
    BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({ color: parsed.background, symbolColor: parsed.foreground, height: 36 });
  });
  ipcMain.handle(IPC_CHANNELS.invoke, handleInvoke);
  ipcMain.handle(IPC_CHANNELS.selectDirectory, handleSelectDirectory);
  ipcMain.handle(IPC_CHANNELS.selectFiles, handleSelectFiles);
  ipcMain.handle(IPC_CHANNELS.openPath, handleOpenPath);
  ipcMain.handle(IPC_CHANNELS.editors, (event) => isTrustedSender(event) ? editors.list() : []);
  ipcMain.handle(IPC_CHANNELS.openInEditor, async (event, request: unknown) => {
    if (!isTrustedSender(event)) return "invalid";
    let parsed;
    try { parsed = object({ editorId: text({ maxLength: 100 }), path: text({ maxLength: 4096 }), base: optional(text({ maxLength: 4096 })) })(request, ""); }
    catch { return "invalid"; }
    return editors.open(parsed, async () => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner) return undefined;
      const result = await dialog.showOpenDialog(owner, { title: "Choose an editor", properties: ["openFile"],
        ...(process.platform === "darwin" ? { defaultPath: "/Applications", filters: [{ name: "Applications", extensions: ["app"] }] } : process.platform === "win32" ? { filters: [{ name: "Applications", extensions: ["exe"] }] } : {}) });
      return result.canceled ? undefined : result.filePaths[0];
    });
  });
  ipcMain.handle(IPC_CHANNELS.openTimelineWindow, handleTimelineWindow);
  ipcMain.handle(IPC_CHANNELS.presentBrowser, (event, request: unknown) => {
    if (!isTrustedSender(event)) return;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner !== null) sharedBrowser.present(owner, validateBrowserPresentation(request, ""));
  });
  // RACK_DATA_DIR isolates development or test data from the default
  // `~/.rack` directory used by the host.
  const dataDirectory = process.env["RACK_DATA_DIR"];
  host = new HostProcess({
    modulePath: paths.host,
    args: dataDirectory === undefined || dataDirectory === "" ? [] : [`--data-directory=${dataDirectory}`],
    onEvent: broadcast,
    onBrowserRequest: (sessionId, request) => {
      const params = validateCommandParams("browser.control", { sessionId, request });
      return sharedBrowser.control(params.sessionId, params.request);
    },
    onExit: (code) => {
      sharedBrowser.shutdown();
      broadcast({ type: "host.status", status: "exited", detail: `Execution host exited with code ${code}.` });
    },
  });
  void host.ready.then(() => broadcast({ type: "host.status", status: "ready" }));
  openWindow();
});
