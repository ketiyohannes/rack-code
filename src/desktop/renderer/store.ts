/**
 * Renderer state container.
 *
 * One immutable `AppState` object, replaced on every update. Features
 * subscribe with a selector and are re-rendered only when the selected slice
 * changes by reference, so editing one part of the state does not redraw
 * unrelated panels (or wipe in-progress form input, which lives in static
 * DOM that is never re-rendered).
 *
 * Notifications are batched to one animation frame. A streaming run can emit
 * many deltas per frame; batching keeps redraws bounded by the display rate.
 *
 * Host data is a view cache rebuilt from queries after reload. Per-device
 * interface preferences are restored separately from localStorage.
 */
import type {
  AccountView,
  ApprovalRequest,
  ConnectProviderView,
  ConnectView,
  ProviderDiagnostic,
  HostErrorCode,
  RunView,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeView,
  ModelView,
  SessionSummaryView,
  SessionView,
  JournalEntryView,
  UserQuestionRequest,
  ProjectView,
} from "../../contracts/desktop/index.js";

/** A run the host is executing, as mirrored by this renderer. */
export interface LiveRun {
  readonly run: RunView;
  readonly events: readonly RuntimeEvent[];
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly pendingQuestions?: readonly UserQuestionRequest[];
  /** Decisions made while this renderer was connected, keyed by approval ID. */
  readonly decisions: Readonly<Record<string, "allow" | "deny">>;
  readonly cancelRequested: boolean;
  readonly fallbackFromAccountId?: string;
}

export interface Notice {
  readonly kind: "error" | "info";
  readonly message: string;
  readonly code?: HostErrorCode;
  /** Optional recovery action rendered as a button. */
  readonly action?: { readonly label: string; readonly run: () => void };
}

/** Sections of the settings overlay. Only some have content today. */
export type SettingsSection = "general" | "accounts" | "models" | "permissions" | "plugins" | "shortcuts" | "notifications" | "about";

export interface AppState {
  readonly page: "chat" | "usage" | "pull-requests";
  readonly reviewProjectId?: string;
  readonly host: { readonly status: "connecting" | "ready" | "exited"; readonly detail?: string };
  readonly accounts: readonly AccountView[];
  readonly runtimes: readonly RuntimeView[];
  /** Unified model catalog; each entry carries hidden host routing metadata. */
  readonly models: readonly ModelView[];
  /** Per-device starred routing keys, retained even while a model is unavailable. */
  readonly favoriteModelKeys: readonly string[];
  readonly modelCatalogFailures: readonly { readonly providerName: string; readonly accountId: string }[];
  /** Top-level projects rendered by the navigator. */
  readonly projects: readonly ProjectView[];
  /** Sessions of every project, grouped by project in the sidebar. */
  readonly sessions: readonly SessionSummaryView[];
  readonly selection: {
    readonly projectId?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly runId?: string | undefined;
  };
  /** The selected session's full record and persisted runs. */
  readonly session?: SessionView | undefined;
  readonly runs: readonly RunView[];
  /** Persisted/current-session activity, retained when a live run finishes. */
  readonly transcripts: Readonly<Record<string, readonly RuntimeEvent[]>>;
  /** Every run the host is executing, across sessions, keyed by run ID. */
  readonly live: Readonly<Record<string, LiveRun>>;
  /** Journal of the run open in the detail panel. */
  readonly journal?: { readonly runId: string; readonly entries: readonly JournalEntryView[] } | undefined;
  /** Capabilities for the composer's runtime/account pair, keyed `runtime|account`. */
  readonly capabilities: Readonly<Record<string, RuntimeCapabilities>>;
  readonly settings: { readonly open: boolean; readonly section: SettingsSection };
  /** Providers offering "Connect <provider> account". */
  readonly connectProviders: readonly ConnectProviderView[];
  /** Sign-ins by connect ID: in progress, or finished and not yet dismissed. */
  readonly connects: Readonly<Record<string, ConnectView>>;
  /** Explicit connection checks, held only for this window. Keys encode provider/account. */
  readonly providerDiagnostics: Readonly<Record<string, { readonly pending: boolean; readonly result?: ProviderDiagnostic; readonly error?: string }>>;
  /** Plugin surfaces enabled in Settings > Plugins (see surfaces.ts). */
  readonly enabledPlugins: readonly string[];
  /** Account to scroll to and outline, e.g. after a duplicate-account error. */
  readonly highlightAccountId?: string | undefined;
  /** Runs with an `unknown` outcome that the user explicitly acknowledged. */
  readonly acknowledgedUnknown: Readonly<Record<string, true>>;
  readonly notice?: Notice | undefined;
}

export const INITIAL_STATE: AppState = {
  page: "chat",
  host: { status: "connecting" },
  accounts: [],
  runtimes: [],
  models: [],
  favoriteModelKeys: [],
  modelCatalogFailures: [],
  projects: [],
  sessions: [],
  selection: {},
  runs: [],
  transcripts: {},
  live: {},
  capabilities: {},
  settings: { open: false, section: "general" },
  enabledPlugins: [],
  connectProviders: [],
  connects: {},
  providerDiagnostics: {},
  acknowledgedUnknown: {},
};

type Listener = () => void;

export class Store {
  private state: AppState = INITIAL_STATE;
  private readonly listeners = new Set<Listener>();
  private scheduled = false;

  get(): AppState {
    return this.state;
  }

  update(change: (state: AppState) => AppState): void {
    const next = change(this.state);
    if (next === this.state) {
      return;
    }
    this.state = next;
    this.schedule();
  }

  /**
   * Calls `render` with the selected slice now and whenever it changes.
   * Selectors returning a fresh object every time defeat the comparison;
   * return existing references or arrays of them.
   */
  watch<T>(select: (state: AppState) => T, render: (slice: T, state: AppState) => void): () => void {
    let previous = select(this.state);
    render(previous, this.state);
    const listener = () => {
      const current = select(this.state);
      if (!shallowEqual(previous, current)) {
        previous = current;
        render(current, this.state);
      }
    };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const listener of [...this.listeners]) {
        listener();
      }
    });
  }
}

/** Reference equality, extended one level into arrays so tuple selectors work. */
function shallowEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  return left === right;
}
