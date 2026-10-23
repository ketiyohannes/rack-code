/**
 * Typed client for host commands and events, over any `ClientTransport`.
 *
 * `call` unwraps `CommandResponse`: it resolves with the result or throws a
 * `HostCommandError` whose `code` callers can switch on. That is the whole
 * reason this layer exists — the UI should never branch on `ok`.
 *
 * Shell operations (folder pickers, opening a path or an editor, presenting
 * the shared browser) belong to the machine the window runs on, so they are
 * only available when the transport has a shell behind it. On a remote
 * connection they raise `feature_unavailable`, the same error the host
 * raises for a feature that was not assembled, so existing UI handling
 * applies unchanged instead of a new failure mode leaking into every panel.
 */
import {
  HostCommandError,
  type CommandParams,
  type CommandResult,
  type HostCommand,
  type HostEvent,
  type SelectDirectoryOptions,
  type OpenPathRequest,
  type OpenPathResult,
  type AttachmentKind,
  type TimelineWindowRequest,
} from "@rack/contracts";
import type { EditorTarget, OpenEditorRequest, OpenEditorResult } from "@rack/contracts/editors";
import type { BrowserPresentation } from "@rack/features/browser";

import { createBridgeTransport } from "./bridge-transport.js";
import type { ClientTransport, ConnectionStatus, ShellOperations } from "./transport.js";

export interface HostClient {
  call<C extends HostCommand>(command: C, params: CommandParams<C>): Promise<CommandResult<C>>;
  onEvent(listener: (event: HostEvent) => void): () => void;
  /**
   * Connection state, for transports whose link can drop. Returns a no-op
   * unsubscribe on transports that are always either present or gone, so
   * callers never have to test for it.
   */
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  /** Whether this client can perform desktop-shell operations at all. */
  readonly hasShell: boolean;
  /** Native folder picker; `undefined` when cancelled. */
  selectDirectory(options?: SelectDirectoryOptions): Promise<string | undefined>;
  selectFiles(kind: AttachmentKind): Promise<readonly string[]>;
  /** Opens or reveals a clicked path through the desktop shell. */
  openPath(request: OpenPathRequest): Promise<OpenPathResult>;
  listEditors(): Promise<readonly EditorTarget[]>;
  openInEditor(request: OpenEditorRequest): Promise<OpenEditorResult>;
  openTimelineWindow(request: TimelineWindowRequest): Promise<void>;
  presentBrowser(request: BrowserPresentation): Promise<void>;
  onBrowserAddressFocus(listener: () => void): () => void;
  /** Releases the transport, where it can be released. */
  close(): void;
}

export function createHostClient(transport: ClientTransport = createBridgeTransport()): HostClient {
  const shell = (): ShellOperations => {
    if (transport.shell === undefined) {
      throw new HostCommandError({
        code: "feature_unavailable",
        name: "ShellUnavailableError",
        message: "This operation needs the desktop app; it is not available over a remote connection.",
      });
    }
    return transport.shell;
  };

  return {
    hasShell: transport.shell !== undefined,
    async call(command, params) {
      const response = await transport.invoke(command, params);
      if (!response.ok) {
        throw new HostCommandError(response.error);
      }
      return response.value;
    },
    onEvent: (listener) => transport.onEvent(listener),
    onStatus: (listener) => transport.onStatus?.(listener) ?? (() => undefined),
    selectDirectory: (options) => shell().selectDirectory(options),
    selectFiles: (kind) => shell().selectFiles(kind),
    listEditors: () => shell().listEditors(),
    openInEditor: (request) => shell().openInEditor(request),
    openPath: (request) => shell().openPath(request),
    onBrowserAddressFocus: (listener) => shell().onBrowserAddressFocus(listener),
    presentBrowser: (request) => shell().presentBrowser(request),
    async openTimelineWindow(request) {
      const response = await shell().openTimelineWindow(request);
      if (!response.ok) throw new HostCommandError(response.error);
    },
    close: () => transport.close?.(),
  };
}
