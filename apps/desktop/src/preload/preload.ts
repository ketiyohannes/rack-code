/**
 * Preload bridge: the renderer's only route to privileged operations.
 *
 * Exposes `window.harness` (`HarnessBridge`): host commands, host events,
 * the native folder picker, and opening clicked paths. It forwards arguments without interpreting
 * them; main validates everything. Raw `ipcRenderer` is never exposed, so
 * page code cannot reach other channels. Bundled as CommonJS because
 * sandboxed preloads cannot load ES modules.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { HostEvent } from "@rack/contracts/events";
import { IPC_CHANNELS, type HarnessBridge } from "@rack/contracts/transport";

const bridge: HarnessBridge = {
  windowAction: (action) => ipcRenderer.invoke(IPC_CHANNELS.windowAction, action),
  windowTheme: (colors) => ipcRenderer.invoke(IPC_CHANNELS.windowTheme, colors),
  invoke: (command, params) => ipcRenderer.invoke(IPC_CHANNELS.invoke, command, params),
  selectDirectory: (options) => ipcRenderer.invoke(IPC_CHANNELS.selectDirectory, options),
  selectFiles: (kind) => ipcRenderer.invoke(IPC_CHANNELS.selectFiles, kind),
  listEditors: () => ipcRenderer.invoke(IPC_CHANNELS.editors),
  openInEditor: (request) => ipcRenderer.invoke(IPC_CHANNELS.openInEditor, request),
  openPath: (request) => ipcRenderer.invoke(IPC_CHANNELS.openPath, request),
  openTimelineWindow: (request) => ipcRenderer.invoke(IPC_CHANNELS.openTimelineWindow, request),
  presentBrowser: (request) => ipcRenderer.invoke(IPC_CHANNELS.presentBrowser, request),
  onBrowserAddressFocus: (listener) => {
    const handle = () => listener();
    ipcRenderer.on(IPC_CHANNELS.focusBrowserAddress, handle);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.focusBrowserAddress, handle);
  },
  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: HostEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.event, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld("harness", bridge);
