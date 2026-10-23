/**
 * What a `HostClient` needs from whatever carries its commands.
 *
 * Rack's user interface runs against two very different links: the Electron
 * preload bridge, where the host is a sibling process on the same machine,
 * and a WebSocket to a daemon that may be a VPS on the other side of a
 * flaky network. This interface is the seam between them, and it is shaped
 * by the two ways those links genuinely differ.
 *
 * **Shell operations are not universal.** `selectDirectory`, `openPath`,
 * opening an editor and presenting the shared browser are all operations of
 * the machine the *window* runs on, performed by Electron main. A daemon has
 * no windows, so a remote transport cannot offer them. Rather than let them
 * fail in some unpredictable way, `shell` is optional and absent on remote
 * transports; `HostClient` turns a call into a `feature_unavailable` error
 * the UI already knows how to show.
 *
 * **Connection state is not universal either.** A preload bridge is either
 * there or the renderer is gone with it, while a remote connection drops,
 * retries and resumes. `onStatus` is therefore optional, and transports that
 * can lose their link report through it.
 */
import type {
  AttachmentKind,
  CommandParams,
  CommandResult,
  CommandResponse,
  HostCommand,
  HostEvent,
  OpenPathRequest,
  OpenPathResult,
  SelectDirectoryOptions,
  TimelineWindowRequest,
} from "@rack/contracts";
import type { EditorTarget, OpenEditorRequest, OpenEditorResult } from "@rack/contracts/editors";
import type { BrowserPresentation } from "@rack/features/browser";

/**
 * Operations performed by the desktop shell around the window, not by the
 * host. Present only on transports that have a shell behind them.
 */
export interface ShellOperations {
  selectDirectory(options?: SelectDirectoryOptions): Promise<string | undefined>;
  selectFiles(kind: AttachmentKind): Promise<readonly string[]>;
  openPath(request: OpenPathRequest): Promise<OpenPathResult>;
  listEditors(): Promise<readonly EditorTarget[]>;
  openInEditor(request: OpenEditorRequest): Promise<OpenEditorResult>;
  openTimelineWindow(request: TimelineWindowRequest): Promise<CommandResponse<null>>;
  presentBrowser(request: BrowserPresentation): Promise<void>;
  onBrowserAddressFocus(listener: () => void): () => void;
}

/** How a resumable transport is currently placed relative to its host. */
export interface ConnectionStatus {
  readonly state: "connecting" | "online" | "offline";
  /** Human-readable cause, shown in connection UI. Never a token. */
  readonly detail?: string;
  /**
   * Present on the first `online` after a reconnect. `truncated` means the
   * missed events are gone and the client must re-read state; `replayed`
   * means the gap was filled and cached state is still good.
   */
  readonly resume?: "fresh" | "replayed" | "truncated";
  /** True once the transport has given up retrying. */
  readonly fatal?: boolean;
}

export interface ClientTransport {
  /** Sends one command; resolves with the envelope, never throws for a refused command. */
  invoke<C extends HostCommand>(command: C, params: CommandParams<C>): Promise<CommandResponse<CommandResult<C>>>;
  /** Subscribes to host events; returns an unsubscribe function. */
  onEvent(listener: (event: HostEvent) => void): () => void;
  /** Absent when the transport has no desktop shell behind it. */
  readonly shell?: ShellOperations | undefined;
  /** Present only on transports whose link can drop and come back. */
  onStatus?(listener: (status: ConnectionStatus) => void): () => void;
  /** Releases the link. Transports that cannot be closed omit this. */
  close?(): void;
}
