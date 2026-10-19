/**
 * Wire envelopes and channel names for the two desktop process hops:
 *
 *   renderer --(Electron IPC, via preload)--> main --(utility process port)--> host
 *
 * The renderer never sees these envelopes directly; the preload bridge
 * exposes `HarnessBridge` instead. Main and the host exchange `HostInbound`
 * and `HostOutbound` messages, correlated by a numeric request ID.
 */
import type { CommandParams, CommandResult, HostCommand } from "./commands.js";
import type { HostErrorPayload } from "./errors.js";
import type { HostEvent } from "./events.js";
import type { TimelineSnapshotTarget } from "./views.js";
import type { BrowserPresentation, BrowserRequest, BrowserSnapshot } from "../../features/browser/index.js";

/** Electron IPC channel names shared by main and preload. */
export const IPC_CHANNELS = {
  /** Renderer to main request; answered with `CommandResponse`. */
  invoke: "harness:invoke",
  /** Main to renderer broadcast of `HostEvent`. */
  event: "harness:event",
  /**
   * Renderer to main: show the native folder picker. A desktop-shell
   * operation handled by main, not an application command for the host.
   */
  selectDirectory: "harness:select-directory",
  /** Main shows a native multi-file picker; the host imports chosen files separately. */
  selectFiles: "harness:select-files",
  /**
   * Renderer to main: open (or reveal) a file or folder the user clicked.
   * A desktop-shell operation handled by main, not an application command.
   */
  openPath: "harness:open-path",
  editors: "harness:editors",
  openInEditor: "harness:open-in-editor",
  /** Opens a separate read-only snapshot window using only app identities. */
  openTimelineWindow: "harness:open-timeline-window",
  presentBrowser: "harness:present-browser",
  focusBrowserAddress: "harness:focus-browser-address",
  windowAction: "harness:window-action",
  windowTheme: "harness:window-theme",
} as const;

export type CommandResponse<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HostErrorPayload };

/** Messages main sends to the host process. */
export type HostInbound =
  | { readonly kind: "browser_response"; readonly id: number; readonly response: CommandResponse<BrowserSnapshot> }
  | { readonly kind: "request"; readonly id: number; readonly command: HostCommand; readonly params: unknown }
  /**
   * Stop-on-exit: cancel every active run and wait (bounded by `timeoutMs`)
   * for terminal states to be persisted before the host is terminated.
   */
  | { readonly kind: "shutdown"; readonly id: number; readonly timeoutMs: number };

/** Messages the host sends to main. */
export type HostOutbound =
  | { readonly kind: "browser_request"; readonly id: number; readonly sessionId: string; readonly request: BrowserRequest }
  | { readonly kind: "ready" }
  | { readonly kind: "response"; readonly id: number; readonly response: CommandResponse }
  | { readonly kind: "event"; readonly event: HostEvent };

/**
 * API the preload script exposes to the renderer as `window.harness`. It is
 * the renderer's only route to privileged operations.
 */
export interface HarnessBridge {
  /** Shell-only allowlisted actions; no host/domain access. */
  windowAction?(action: WindowAction): Promise<void>;
  windowTheme?(colors: { background: string; foreground: string }): Promise<void>;
  invoke<C extends HostCommand>(command: C, params: CommandParams<C>): Promise<CommandResponse<CommandResult<C>>>;
  /** Subscribes to host events; returns an unsubscribe function. */
  onEvent(listener: (event: HostEvent) => void): () => void;
  /**
   * Opens the native folder picker attached to the calling window. Resolves
   * with the chosen absolute path, or `undefined` when the user cancels.
   */
  selectDirectory(options?: SelectDirectoryOptions): Promise<string | undefined>;
  selectFiles(kind: AttachmentKind): Promise<readonly string[]>;
  /**
   * Opens a clicked path with its default application, or reveals it in the
   * file manager when opening could execute it. Main resolves and checks it.
   */
  openPath(request: OpenPathRequest): Promise<OpenPathResult>;
  listEditors(): Promise<readonly import("./editors.js").EditorTarget[]>;
  openInEditor(request: import("./editors.js").OpenEditorRequest): Promise<import("./editors.js").OpenEditorResult>;
  openTimelineWindow(request: TimelineWindowRequest): Promise<CommandResponse<null>>;
  presentBrowser(request: BrowserPresentation): Promise<void>;
  /** Main redirects Cmd/Ctrl+L from the isolated native page to app chrome. */
  onBrowserAddressFocus(listener: () => void): () => void;
}

export const WINDOW_ACTIONS = ["undo", "redo", "cut", "copy", "paste", "selectAll", "reload", "devTools", "zoomIn", "zoomOut", "resetZoom", "fullscreen", "close", "quit", "help", "about"] as const;
export type WindowAction = typeof WINDOW_ACTIONS[number];

export interface TimelineWindowRequest extends TimelineSnapshotTarget {
  /** Optional initial selection; the host still validates tree membership. */
  readonly path?: string;
}

export interface OpenPathRequest {
  /** Path as written in the UI: absolute, `~/`, or relative, optionally with `:line[:column]`. */
  readonly path: string;
  /** Absolute folder that relative paths resolve against (the project folder). */
  readonly base?: string;
}

/** What main did with the path. Only these outcomes cross back to the renderer. */
export type OpenPathResult = "opened" | "revealed" | "missing" | "invalid";

export interface SelectDirectoryOptions {
  /** Dialog title, for example "Choose project folder". */
  readonly title?: string;
  /** Folder the dialog starts in. */
  readonly defaultPath?: string;
}

/** These categories only filter the picker; all files use the same import path. */
export const ATTACHMENT_KINDS = ["images", "documents", "code", "all"] as const;
export type AttachmentKind = typeof ATTACHMENT_KINDS[number];
