/**
 * Typed renderer-side client over the preload bridge.
 *
 * `call` unwraps `CommandResponse`: it resolves with the result or throws a
 * `HostCommandError` whose `code` callers can switch on.
 */
import {
  HostCommandError,
  type CommandParams,
  type CommandResult,
  type HarnessBridge,
  type HostCommand,
  type HostEvent,
  type SelectDirectoryOptions,
  type OpenPathRequest,
  type OpenPathResult,
  type AttachmentKind,
  type TimelineWindowRequest,
} from "../../contracts/desktop/index.js";
import type { BrowserPresentation } from "../../features/browser/index.js";

declare global {
  interface Window {
    readonly harness: HarnessBridge;
  }
}

export interface HostClient {
  call<C extends HostCommand>(command: C, params: CommandParams<C>): Promise<CommandResult<C>>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  /** Native folder picker; `undefined` when cancelled. */
  selectDirectory(options?: SelectDirectoryOptions): Promise<string | undefined>;
  selectFiles(kind: AttachmentKind): Promise<readonly string[]>;
  /** Opens or reveals a clicked path through Electron main. */
  openPath(request: OpenPathRequest): Promise<OpenPathResult>;
  listEditors(): Promise<readonly import("../../contracts/desktop/editors.js").EditorTarget[]>;
  openInEditor(request: import("../../contracts/desktop/editors.js").OpenEditorRequest): Promise<import("../../contracts/desktop/editors.js").OpenEditorResult>;
  openTimelineWindow(request: TimelineWindowRequest): Promise<void>;
  presentBrowser(request: BrowserPresentation): Promise<void>;
  onBrowserAddressFocus(listener: () => void): () => void;
}

export function createHostClient(bridge: HarnessBridge = window.harness): HostClient {
  return {
    async call(command, params) {
      const response = await bridge.invoke(command, params);
      if (!response.ok) {
        throw new HostCommandError(response.error);
      }
      return response.value;
    },
    onEvent: (listener) => bridge.onEvent(listener),
    selectDirectory: (options) => bridge.selectDirectory(options),
    selectFiles: (kind) => bridge.selectFiles(kind),
    listEditors: () => bridge.listEditors(),
    openInEditor: (request) => bridge.openInEditor(request),
    openPath: (request) => bridge.openPath(request),
    onBrowserAddressFocus: (listener) => bridge.onBrowserAddressFocus(listener),
    presentBrowser: (request) => bridge.presentBrowser(request),
    async openTimelineWindow(request) {
      const response = await bridge.openTimelineWindow(request);
      if (!response.ok) throw new HostCommandError(response.error);
    },
  };
}
