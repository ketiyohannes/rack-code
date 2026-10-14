/**
 * Renderer-side coordinator between the host client and the store.
 *
 * Features call these methods instead of talking to the host directly, so
 * loading, refreshing after events, and error presentation are implemented
 * once. The controller holds no domain rules: account choice, workspace
 * locking, approvals, and run state all stay in the host. It only decides
 * what to (re)load and how to present failures.
 *
 * Reconnect contract: the controller subscribes to host events before it
 * loads the `runs.active` snapshot. Live events whose index is already in the
 * snapshot are skipped; a gap triggers a fresh snapshot. A reload therefore
 * never starts or duplicates a run, it only re-reads host state.
 */
import {
  HostCommandError,
  type ConnectView,
  type HostEvent,
  type StartRunParams,
  type WorkspaceView,
  type ActiveRunView,
  type RunView,
} from "../../contracts/desktop/index.js";
import type { HostClient } from "./host-client.js";
import { loadEnabledPlugins, saveEnabledPlugins } from "./surfaces.js";
import type { AppState, LiveRun, Notice, SettingsSection, Store } from "./store.js";

export class Controller {
  private ready = false;
  /** Sign-ins started from this window; only these may open a browser tab. */
  private readonly ownConnects = new Set<string>();
  private readonly bufferedEvents: HostEvent[] = [];
  private readonly reloads = new Map<string, Promise<void>>();

  constructor(
    private readonly host: HostClient,
    private readonly store: Store,
  ) {}

  async start(): Promise<void> {
    this.host.onEvent((event) => {
      if (this.ready) {
        this.handleEvent(event);
      } else {
        this.bufferedEvents.push(event);
      }
    });
    try {
      const [connectProviders, connecting, accounts, runtimes, models, projects, sessions, active] = await Promise.all([
        this.host.call("auth.providers", {}),
        this.host.call("auth.active", {}),
        this.host.call("accounts.list", {}),
        this.host.call("runtimes.list", {}),
        this.host.call("models.list", {}),
        this.host.call("projects.list", {}),
        this.host.call("sessions.list", {}),
        this.host.call("runs.active", {}),
      ]);
      this.store.update((state) => ({
        ...state,
        host: { status: "ready" },
        accounts,
        runtimes,
        models,
        projects,
        sessions,
        connectProviders,
        connects: Object.fromEntries(connecting.map((connect) => [connect.connectId, connect])),
        live: liveFromSnapshot(active, state.live),
      }));
      this.ready = true;
      for (const event of this.bufferedEvents.splice(0)) {
        this.handleEvent(event);
      }
      // Open the most recently updated session, or the first project.
      const firstSession = sessions[0];
      const firstProject = projects[0];
      if (firstSession !== undefined) {
        await this.selectSession(firstSession.id);
      } else if (firstProject !== undefined) {
        await this.selectProject(firstProject.id);
      }
    } catch (error) {
      this.ready = true;
      this.report(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation

  /** Makes a project current (for workspace management) without opening a session. */
  async selectProject(projectId: string): Promise<void> {
    if (this.store.get().selection.projectId === projectId) return;
    this.store.update((state) => ({
      ...state,
      selection: { projectId, sessionId: undefined, runId: undefined },
      session: undefined,
      runs: [],
      workspaces: [],
      journal: undefined,
    }));
    await this.reloadWorkspaces(projectId);
  }

  /** Opens a session; its project becomes the current project. */
  async selectSession(sessionId: string): Promise<void> {
    const projectId = this.store.get().sessions.find((session) => session.id === sessionId)?.projectId;
    const projectChanged = projectId !== undefined && projectId !== this.store.get().selection.projectId;
    this.store.update((state) => ({
      ...state,
      selection: { projectId: projectId ?? state.selection.projectId, sessionId, runId: undefined },
      ...(projectChanged ? { workspaces: [] } : {}),
    }));
    await Promise.all([
      this.reloadSession(sessionId),
      projectChanged && projectId !== undefined ? this.reloadWorkspaces(projectId) : Promise.resolve(),
    ]);
  }

  /** Expands a run's details in the transcript, or collapses them when already open. */
  async selectRun(runId: string): Promise<void> {
    if (this.store.get().selection.runId === runId) {
      this.store.update((state) => ({ ...state, selection: { ...state.selection, runId: undefined } }));
      return;
    }
    this.store.update((state) => ({ ...state, selection: { ...state.selection, runId } }));
    await this.reloadJournal(runId);
  }

  openSettings(section?: SettingsSection): void {
    this.store.update((state) => ({
      ...state,
      settings: { open: true, section: section ?? state.settings.section },
    }));
  }

  /** Loads per-device renderer preferences; call once before `start`. */
  loadPreferences(): void {
    this.store.update((state) => ({ ...state, enabledPlugins: loadEnabledPlugins() }));
  }

  setPluginEnabled(pluginId: string, enabled: boolean): void {
    this.store.update((state) => {
      const others = state.enabledPlugins.filter((id) => id !== pluginId);
      const enabledPlugins = enabled ? [...others, pluginId] : others;
      saveEnabledPlugins(enabledPlugins);
      return { ...state, enabledPlugins };
    });
  }

  closeSettings(): void {
    this.store.update((state) => ({
      ...state,
      settings: { ...state.settings, open: false },
      highlightAccountId: undefined,
    }));
  }

  // ---------------------------------------------------------------------------
  // Projects, workspaces, sessions

  /**
   * Creates a project and, when requested, a shared workspace at its root.
   * The workspace is an explicit user choice in the form, not an implicit
   * policy: projects and workspaces stay separate records in the core.
   */
  async createProject(name: string, rootPath: string, createRootWorkspace: boolean): Promise<boolean> {
    return this.attempt(async () => {
      const project = await this.host.call("projects.create", { name, rootPath });
      if (createRootWorkspace) {
        await this.host.call("workspaces.create", { projectId: project.id, path: rootPath, kind: "shared" });
      }
      await this.reloadProjects();
      await this.selectProject(project.id);
    });
  }

  async createWorkspace(params: { path: string; kind: "shared" | "isolated"; startingRevision?: string }): Promise<boolean> {
    const projectId = this.store.get().selection.projectId;
    if (projectId === undefined) return false;
    return this.attempt(async () => {
      await this.host.call("workspaces.create", { projectId, ...params });
      await this.reloadWorkspaces(projectId);
    });
  }

  async createSession(projectId: string, workspaceId: string, title?: string): Promise<boolean> {
    return this.attempt(async () => {
      const session = await this.host.call("sessions.create", {
        projectId,
        workspaceId,
        ...(title === undefined ? {} : { title }),
      });
      await this.reloadSessions();
      await this.selectSession(session.id);
    });
  }

  /** Workspaces of any project, for the new-session form under a project folder. */
  async listWorkspaces(projectId: string): Promise<readonly WorkspaceView[]> {
    try {
      return await this.host.call("workspaces.list", { projectId });
    } catch (error) {
      this.report(error);
      return [];
    }
  }

  /** Native folder picker (desktop shell, not the host); `undefined` on cancel. */
  async selectDirectory(title: string, defaultPath?: string): Promise<string | undefined> {
    try {
      return await this.host.selectDirectory({ title, ...(defaultPath === undefined ? {} : { defaultPath }) });
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Accounts

  async selectAccount(providerId: string, accountId: string): Promise<void> {
    await this.attempt(async () => {
      await this.host.call("accounts.select", { providerId, accountId });
      await this.reloadAccounts();
    });
  }

  /** Opens Settings > Accounts and starts reconnecting the account. */
  openReauthenticate(accountId: string): void {
    const account = this.store.get().accounts.find((candidate) => candidate.id === accountId);
    this.store.update((state) => ({
      ...state,
      settings: { open: true, section: "accounts" },
      highlightAccountId: accountId,
    }));
    if (account !== undefined) void this.connectAccount(account.providerId, account.id);
  }

  /**
   * Starts "Connect <provider> account", or a reconnect when `accountId` is
   * given. When the provider does not open the sign-in page itself, this
   * window opens it in the default browser once the URL is known.
   */
  async connectAccount(providerId: string, accountId?: string): Promise<void> {
    await this.attempt(async () => {
      const connect = await this.host.call("auth.connect", {
        providerId,
        ...(accountId === undefined ? {} : { accountId }),
      });
      this.ownConnects.add(connect.connectId);
      this.applyConnect(connect);
    });
  }

  async submitConnectCode(connectId: string, code: string): Promise<void> {
    await this.attempt(() => this.host.call("auth.submitCode", { connectId, code }).then(() => undefined));
  }

  async cancelConnect(connectId: string): Promise<void> {
    await this.attempt(() => this.host.call("auth.cancel", { connectId }).then(() => undefined));
  }

  /** Removes a finished sign-in card. */
  dismissConnect(connectId: string): void {
    this.store.update((state) => {
      const { [connectId]: _removed, ...connects } = state.connects;
      return { ...state, connects };
    });
  }

  /** Opens an https sign-in page in the default browser (main enforces https). */
  openExternal(url: string): void {
    if (url.startsWith("https://")) window.open(url, "_blank", "noopener");
  }

  private applyConnect(connect: ConnectView): void {
    const previous = this.store.get().connects[connect.connectId];
    this.store.update((state) => ({ ...state, connects: { ...state.connects, [connect.connectId]: connect } }));
    // Open the page once, when its URL first appears, for sign-ins this
    // window started and the provider did not open itself.
    if (connect.url !== undefined && previous?.url === undefined &&
        connect.urlOpenedByProvider !== true && this.ownConnects.has(connect.connectId)) {
      this.openExternal(connect.url);
    }
    if (connect.status === "completed") {
      this.ownConnects.delete(connect.connectId);
      void this.reloadAccounts();
    } else if (connect.status !== "waiting") {
      this.ownConnects.delete(connect.connectId);
    }
  }

  async loadCapabilities(runtimeId: string, accountId: string): Promise<void> {
    const key = `${runtimeId}|${accountId}`;
    if (this.store.get().capabilities[key] !== undefined) return;
    try {
      const capabilities = await this.host.call("runtimes.capabilities", { runtimeId, accountId });
      this.store.update((state) => ({ ...state, capabilities: { ...state.capabilities, [key]: capabilities } }));
    } catch (error) {
      this.report(error);
    }
  }

  /** Refreshes the provider-neutral model catalog after account changes. */
  async reloadModels(): Promise<void> {
    try {
      const models = await this.host.call("models.list", {});
      this.store.update((state) => ({ ...state, models }));
    } catch (error) {
      this.report(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Runs

  async startRun(params: StartRunParams): Promise<boolean> {
    return this.attempt(async () => {
      const started = await this.host.call("runs.start", params);
      this.addLiveRun(started.run, started.fallbackFromAccountId);
      if (started.fallbackFromAccountId !== undefined) {
        const accounts = this.store.get().accounts;
        const from = accounts.find((account) => account.id === started.fallbackFromAccountId);
        const to = accounts.find((account) => account.id === started.run.accountId);
        this.notify({
          kind: "info",
          message: `Selected account ${label(from, started.fallbackFromAccountId)} is not available; this run uses ${label(to, started.run.accountId)}.`,
        });
      }
    }, (error) => {
      if (error instanceof HostCommandError && error.code === "workspace_busy") {
        return {
          kind: "error",
          code: error.code,
          message: `This workspace is being edited by attempt ${error.details["attemptId"] ?? "unknown"}. Retry after it finishes.`,
          action: { label: "Retry", run: () => void this.startRun(params) },
        };
      }
      return undefined;
    });
  }

  async cancelRun(runId: string): Promise<void> {
    // Mark locally first so the button disables immediately; the host's
    // `run.cancel_requested` event confirms it for every client.
    this.patchLive(runId, (live) => ({ ...live, cancelRequested: true }));
    await this.attempt(() => this.host.call("runs.cancel", { runId }).then(() => undefined));
  }

  async respondToApproval(runId: string, approvalId: string, decision: "allow" | "deny"): Promise<void> {
    await this.attempt(() => this.host.call("runs.respondToApproval", { runId, approvalId, decision }).then(() => undefined));
  }

  acknowledgeUnknown(runId: string): void {
    this.store.update((state) => ({ ...state, acknowledgedUnknown: { ...state.acknowledgedUnknown, [runId]: true } }));
  }

  dismissNotice(): void {
    this.store.update((state) => ({ ...state, notice: undefined }));
  }

  // ---------------------------------------------------------------------------
  // Host events

  private handleEvent(event: HostEvent): void {
    const { selection } = this.store.get();
    switch (event.type) {
      case "host.status":
        this.store.update((state) => ({
          ...state,
          host: { status: event.status, ...(event.detail === undefined ? {} : { detail: event.detail }) },
        }));
        return;
      case "run.started":
        this.addLiveRun(event.run, event.fallbackFromAccountId);
        return;
      case "run.updated":
        this.patchLive(event.run.id, (live) => ({ ...live, run: event.run }));
        return;
      case "run.event":
        this.applyRunEvent(event.runId, event.index, event.event);
        return;
      case "run.approval_resolved":
        this.patchLive(event.runId, (live) => ({
          ...live,
          pendingApprovals: live.pendingApprovals.filter((request) => request.id !== event.approval.id),
          decisions: { ...live.decisions, [event.approval.id]: event.decision },
        }));
        return;
      case "run.cancel_requested":
        this.patchLive(event.runId, (live) => ({ ...live, cancelRequested: true }));
        return;
      case "run.finished":
        this.finishRun(event.run);
        return;
      case "auth.updated":
        this.applyConnect(event.connect);
        return;
      case "accounts.changed":
        void this.reloadAccounts();
        void this.reloadModels();
        return;
      case "projects.changed":
        void this.reloadProjects();
        return;
      case "workspaces.changed":
        if (event.projectId === selection.projectId) void this.reloadWorkspaces(event.projectId);
        return;
      case "sessions.changed":
        void this.reloadSessions();
        if (event.sessionId === selection.sessionId) void this.reloadSession(event.sessionId);
        return;
    }
  }

  private addLiveRun(run: RunView, fallbackFromAccountId: string | undefined): void {
    this.store.update((state) => {
      if (state.live[run.id] !== undefined) return state;
      const live: LiveRun = {
        run,
        events: [],
        pendingApprovals: [],
        decisions: {},
        cancelRequested: false,
        ...(fallbackFromAccountId === undefined ? {} : { fallbackFromAccountId }),
      };
      return { ...state, live: { ...state.live, [run.id]: live } };
    });
  }

  private applyRunEvent(runId: string, index: number, event: LiveRun["events"][number]): void {
    const live = this.store.get().live[runId];
    if (live === undefined || index < live.events.length) {
      // Unknown run (its `run.started` will follow) or already in the snapshot.
      return;
    }
    if (index > live.events.length) {
      // A gap means this renderer missed events; re-read the authoritative snapshot.
      void this.resyncActive();
      return;
    }
    this.patchLive(runId, (current) => ({
      ...current,
      events: [...current.events, event],
      pendingApprovals: event.type === "approval_request"
        ? [...current.pendingApprovals, event.request]
        : current.pendingApprovals,
    }));
  }

  private finishRun(run: RunView): void {
    this.store.update((state) => {
      const { [run.id]: _finished, ...live } = state.live;
      const runs = state.selection.sessionId === run.sessionId
        ? upsertRun(state.runs, run)
        : state.runs;
      return { ...state, live, runs };
    });
    if (this.store.get().selection.runId === run.id) {
      void this.reloadJournal(run.id);
    }
  }

  private patchLive(runId: string, change: (live: LiveRun) => LiveRun): void {
    this.store.update((state) => {
      const live = state.live[runId];
      return live === undefined ? state : { ...state, live: { ...state.live, [runId]: change(live) } };
    });
  }

  private async resyncActive(): Promise<void> {
    await this.coalesce("active", async () => {
      const active = await this.host.call("runs.active", {});
      this.store.update((state) => ({ ...state, live: liveFromSnapshot(active, state.live) }));
    });
  }

  // ---------------------------------------------------------------------------
  // Reloads. Concurrent requests for the same key share one in-flight call.

  private reloadAccounts(): Promise<void> {
    return this.coalesce("accounts", async () => {
      const accounts = await this.host.call("accounts.list", {});
      this.store.update((state) => ({ ...state, accounts }));
    });
  }

  private reloadProjects(): Promise<void> {
    return this.coalesce("projects", async () => {
      const projects = await this.host.call("projects.list", {});
      this.store.update((state) => ({ ...state, projects }));
    });
  }

  private reloadWorkspaces(projectId: string): Promise<void> {
    return this.coalesce(`workspaces:${projectId}`, async () => {
      const workspaces = await this.host.call("workspaces.list", { projectId });
      this.store.update((state) => state.selection.projectId === projectId ? { ...state, workspaces } : state);
    });
  }

  private reloadSessions(): Promise<void> {
    return this.coalesce("sessions", async () => {
      const sessions = await this.host.call("sessions.list", {});
      this.store.update((state) => ({ ...state, sessions }));
    });
  }

  private reloadSession(sessionId: string): Promise<void> {
    return this.coalesce(`session:${sessionId}`, async () => {
      const [session, runs] = await Promise.all([
        this.host.call("sessions.get", { sessionId }),
        this.host.call("runs.list", { sessionId }),
      ]);
      this.store.update((state) => state.selection.sessionId === sessionId ? { ...state, session, runs } : state);
    });
  }

  private reloadJournal(runId: string): Promise<void> {
    return this.coalesce(`journal:${runId}`, async () => {
      const entries = await this.host.call("runs.journal", { runId });
      this.store.update((state) => state.selection.runId === runId ? { ...state, journal: { runId, entries } } : state);
    });
  }

  private coalesce(key: string, load: () => Promise<void>): Promise<void> {
    const existing = this.reloads.get(key);
    if (existing !== undefined) return existing;
    const promise = load()
      .catch((error: unknown) => this.report(error))
      .finally(() => this.reloads.delete(key));
    this.reloads.set(key, promise);
    return promise;
  }

  // ---------------------------------------------------------------------------
  // Errors

  /**
   * Runs an operation and converts failures into a notice. Returns true on
   * success so forms know whether to reset.
   */
  private async attempt(
    operation: () => Promise<void>,
    special?: (error: unknown) => Notice | undefined,
  ): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      const notice = special?.(error);
      if (notice !== undefined) {
        this.notify(notice);
      } else {
        this.report(error);
      }
      return false;
    }
  }

  private report(error: unknown): void {
    this.notify(describeError(error, this.store.get()));
    if (error instanceof HostCommandError && error.code === "duplicate_account") {
      const existing = this.store.get().accounts.find((account) =>
        account.providerId === error.details["providerId"] &&
        account.identity.providerAccountId === error.details["providerAccountId"]);
      if (existing !== undefined) {
        this.store.update((state) => ({ ...state, highlightAccountId: existing.id, settings: { open: true, section: "accounts" } }));
      }
    }
  }

  private notify(notice: Notice): void {
    this.store.update((state) => ({ ...state, notice }));
  }
}

/** Maps stable host error codes to actionable messages. Never parses English. */
export function describeError(error: unknown, state: AppState): Notice {
  if (!(error instanceof HostCommandError)) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  const base = { kind: "error" as const, code: error.code };
  switch (error.code) {
    case "duplicate_account":
      return { ...base, message: "This provider identity is already saved. The existing account is highlighted." };
    case "provider_mismatch":
      return { ...base, message: "That account belongs to a different provider than the one selected." };
    case "no_eligible_account":
      return { ...base, message: "No account for this provider is marked available. Choose an account explicitly." };
    case "workspace_busy":
      return { ...base, message: `Workspace is being edited by attempt ${error.details["attemptId"] ?? "unknown"}. Retry after it finishes.` };
    case "workspace_project_mismatch":
      return { ...base, message: "The workspace does not belong to the selected project." };
    case "account_not_found":
    case "project_not_found":
    case "workspace_not_found":
    case "session_not_found":
    case "run_not_found":
    case "attempt_not_found":
    case "runtime_not_found":
      return { ...base, message: `${error.message} Reload the view; it may have been changed elsewhere.` };
    case "connector_not_found":
      return { ...base, message: "Sign-in is not available for that provider." };
    case "connect_not_found":
      return { ...base, message: "That sign-in is no longer in progress." };
    case "approval_not_found":
      return { ...base, message: "That approval was already answered or has expired. Other approvals are unaffected." };
    case "run_not_active":
      return { ...base, message: "That run is no longer active." };
    case "host_unavailable":
      return { ...base, message: state.host.detail ?? "The execution host is not running. Restart the app." };
    case "invalid_input":
    case "unknown_command":
    case "internal":
      return { ...base, message: error.message };
  }
}

function liveFromSnapshot(active: readonly ActiveRunView[], previous: AppState["live"]): AppState["live"] {
  const live: Record<string, LiveRun> = {};
  for (const view of active) {
    live[view.run.id] = {
      run: view.run,
      events: view.events,
      pendingApprovals: view.pendingApprovals,
      decisions: previous[view.run.id]?.decisions ?? {},
      cancelRequested: view.cancelRequested,
      ...(view.fallbackFromAccountId === undefined ? {} : { fallbackFromAccountId: view.fallbackFromAccountId }),
    };
  }
  return live;
}

function upsertRun(runs: readonly RunView[], run: RunView): readonly RunView[] {
  return runs.some((candidate) => candidate.id === run.id)
    ? runs.map((candidate) => candidate.id === run.id ? run : candidate)
    : [...runs, run];
}

function label(account: { identity: { displayName?: string; email?: string; providerAccountId: string } } | undefined, fallback: string | undefined): string {
  if (account === undefined) return fallback ?? "unknown";
  return account.identity.displayName ?? account.identity.email ?? account.identity.providerAccountId;
}
