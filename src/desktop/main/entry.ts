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

import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";

import {
  isHostCommand,
  validateCommandParams,
} from "../../contracts/desktop/commands.js";
import type { HostEvent } from "../../contracts/desktop/events.js";
import { IPC_CHANNELS, type CommandResponse } from "../../contracts/desktop/transport.js";
import { ContractValidationError, object, optional, text } from "../../contracts/desktop/validation.js";
import { HostProcess } from "./host-process.js";
import { resolveShellPath } from "./shell-path.js";
import { createMainWindow } from "./window.js";

/** How long quitting waits for cancelled runs to record a terminal state. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const paths = {
  host: join(bundleDirectory, "host.mjs"),
  preload: join(bundleDirectory, "preload.cjs"),
  index: join(bundleDirectory, "renderer", "index.html"),
};

let host: HostProcess | undefined;
let quitConfirmed = false;

function broadcast(event: HostEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC_CHANNELS.event, event);
  }
}

function openWindow(): void {
  createMainWindow({ preloadPath: paths.preload, indexPath: paths.index });
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

/**
 * Confirms quitting when runs are active, then stops them through the host.
 * Returns false when the user chose to keep working.
 */
async function stopHostForQuit(current: HostProcess): Promise<boolean> {
  const active = await current.request("runs.active", {});
  const count = active.ok && Array.isArray(active.value) ? active.value.length : 0;
  if (count > 0) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Stop runs and quit", "Keep working"],
      defaultId: 1,
      cancelId: 1,
      message: count === 1 ? "1 run is active." : `${count} runs are active.`,
      detail: "Quitting cancels active agent runs and waits briefly for them to record their final state. Partial output is kept.",
    });
    if (response !== 0) {
      return false;
    }
    await current.shutdown(SHUTDOWN_TIMEOUT_MS);
  }
  current.kill();
  return true;
}

app.on("before-quit", (event) => {
  if (quitConfirmed || host === undefined || !host.isRunning) {
    return;
  }
  event.preventDefault();
  const current = host;
  void stopHostForQuit(current).then((stopped) => {
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
  ipcMain.handle(IPC_CHANNELS.invoke, handleInvoke);
  ipcMain.handle(IPC_CHANNELS.selectDirectory, handleSelectDirectory);
  // THINKING_AND_CODE_DATA_DIR isolates development or test data from the
  // default `~/.thinking-and-code` directory used by the host.
  const dataDirectory = process.env["THINKING_AND_CODE_DATA_DIR"];
  // A packaged app started from Finder lacks the shell PATH, so the host
  // could not find the provider CLIs (`codex`, `claude`). Development runs
  // from a terminal already have it.
  const shellPath = app.isPackaged ? resolveShellPath() : process.env["PATH"];
  host = new HostProcess({
    modulePath: paths.host,
    env: { ...process.env, ...(shellPath === undefined ? {} : { PATH: shellPath }) },
    args: dataDirectory === undefined || dataDirectory === "" ? [] : [`--data-directory=${dataDirectory}`],
    onEvent: broadcast,
    onExit: (code) => {
      broadcast({ type: "host.status", status: "exited", detail: `Execution host exited with code ${code}.` });
    },
  });
  void host.ready.then(() => broadcast({ type: "host.status", status: "ready" }));
  openWindow();
});
