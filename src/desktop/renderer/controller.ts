/**
 * Renderer-side coordinator between the host client and the store.
 *
 * Features call these methods instead of talking to the host directly, so
 * loading, refreshing after events, and error presentation are implemented
 * once. The controller holds no domain rules: account choice, project
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
  type ActiveRunView,
  type RunView,
  type SessionDiscovery,
  type ExternalSessionSnapshot,
  type AttachmentKind,
  type SessionView,
  type ProjectView,
  type RuntimeEvent,
  type UserQuestionResponse,
} from "../../contracts/desktop/index.js";
import type { HostClient } from "./host-client.js";
import { loadEnabledPlugins, saveEnabledPlugins } from "./surfaces.js";
import type { AppState, LiveRun, Notice, SettingsSection, Store } from "./store.js";
import { eventsFromJournal } from "./transcript.js";
import { MAX_ATTACHMENTS, type SessionAttachment } from "../../core/sessions/attachments.js";
import { loadModelFavorites, saveModelFavorites } from "./model-favorites.js";
import { modelKey } from "./components/model-settings.js";
import type { BrowserPresentation, BrowserRequest } from "../../features/browser/index.js";

interface CachedSession {
  readonly session: SessionView;
  readonly runs: readonly RunView[];
  readonly transcripts: AppState["transcripts"];
}

/** Bound retained history while making back-and-forth navigation immediate. */
const SESSION_CACHE_LIMIT = 8;

export class Controller {
  private ready = false;
  private modelDiscoveryStarted = false;
  /** Sign-ins started from this window; only these may open a browser tab. */
  private readonly ownConnects = new Set<string>();
  private readonly bufferedEvents: HostEvent[] = [];
  private readonly reloads = new Map<string, Promise<void>>();
  private readonly sessionCache = new Map<string, CachedSession>();
  private readonly sessionCacheSizes = new Map<string, number>();
  private readonly sessionRevisions = new Map<string, number>();
  /** Reject late metadata/list responses for sessions removed by any client. */
  private readonly removedSessions = new Set<string>();
  /** Timeline panel subscribers; Timeline data is panel-owned, not stored globally. */
  private readonly timelineListeners = new Set<(sessionId: string) => void>();

  constructor(
    private readonly host: HostClient,
    private readonly store: Store,
  ) {}

  /** Read-only project snapshot; the Changes panel owns loading/error display. */
  getProjectChanges(projectId: string, repositoryPath?: string) {
    return this.host.call("projects.changes", { projectId, ...(repositoryPath === undefined ? {} : { repositoryPath }) });
  }

  listFiles(projectId: string, path: string) { return projectId.startsWith("chat:") ? this.host.call("sessions.files.list", { sessionId: projectId.slice(5), path }) : this.host.call("files.list", { projectId, path }); }
  readFile(projectId: string, path: string) { return projectId.startsWith("chat:") ? this.host.call("sessions.files.read", { sessionId: projectId.slice(5), path }) : this.host.call("files.read", { projectId, path }); }
  saveFile(projectId: string, path: string, text: string, version: string) { return projectId.startsWith("chat:") ? this.host.call("sessions.files.save", { sessionId: projectId.slice(5), path, text, version }) : this.host.call("files.save", { projectId, path, text, version }); }
  openTerminal(projectId: string | undefined, sessionId: string | undefined, cols: number, rows: number) {
    return this.host.call("terminal.open", { ...(projectId === undefined ? {} : { projectId }), ...(sessionId === undefined ? {} : { sessionId }), cols, rows });
  }
  readTerminal(terminalId: string, after: number) { return this.host.call("terminal.read", { terminalId, after }); }
  writeTerminal(terminalId: string, data: string) { return this.host.call("terminal.write", { terminalId, data }); }
  resizeTerminal(terminalId: string, cols: number, rows: number) { return this.host.call("terminal.resize", { terminalId, cols, rows }); }
  closeTerminal(terminalId: string) { return this.host.call("terminal.close", { terminalId }); }
  controlBrowser(sessionId: string, request: BrowserRequest) { return this.host.call("browser.control", { sessionId, request }); }
  presentBrowser(request: BrowserPresentation) { return this.host.presentBrowser(request); }

  /** Discovery is cached by the host; explicit rescan bypasses that cache. */
  discoverProjectRepositories(projectId: string, options: import("../../contracts/desktop/views.js").RepositoryDiscoveryOptions = {}) {
    return this.host.call("projects.repositories", { projectId, ...options });
  }

  // ---------------------------------------------------------------------------
  // Timeline (optional feature). The panel owns loading and error display, as
  // the Changes panel does, so these return host results or throw.

  timelineStatus(sessionId: string) {
    return this.host.call("timeline.status", { sessionId });
  }

  setTimelineEnabled(sessionId: string, enabled: boolean) {
    return this.host.call("timeline.setEnabled", { sessionId, enabled });
  }

  timelineCheckpoints(sessionId: string) {
    return this.host.call("timeline.checkpoints", { sessionId });
  }

  timelineProjectHistory(projectId: string) {
    return this.host.call("timeline.projectHistory", { projectId });
  }

  setProjectTimelineEnabled(projectId: string, enabled: boolean) {
    return this.host.call("timeline.setProjectEnabled", { projectId, enabled });
  }

  openTimelineWindow(request: import("../../contracts/desktop/index.js").TimelineWindowRequest) {
    return this.host.openTimelineWindow(request);
  }

  timelineProjectFileDiff(projectId: string, checkpointId: string, path: string) {
    return this.host.call("timeline.projectFileDiff", { projectId, checkpointId, path });
  }

  timelineFileDiff(sessionId: string, checkpointId: string, path: string) {
    return this.host.call("timeline.fileDiff", { sessionId, checkpointId, path });
  }

  /** Called with a session ID whenever the host reports Timeline changes for it. */
  onTimelineChanged(listener: (sessionId: string) => void): () => void {
    this.timelineListeners.add(listener);
    return () => this.timelineListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.host.onEvent((event) => {
      if (this.ready) {
        this.handleEvent(event);
      } else {
        this.bufferedEvents.push(event);
      }
    });
    try {
      const [connectProviders, connecting, accounts, runtimes, projects, sessions, active] = await Promise.all([
        this.host.call("auth.providers", {}),
        this.host.call("auth.active", {}),
        this.host.call("accounts.list", {}),
        this.host.call("runtimes.list", {}),
        this.host.call("projects.list", {}),
        this.host.call("sessions.list", {}),
        this.host.call("runs.active", {}),
      ]);
      this.store.update((state) => ({
        ...state,
        host: { status: "ready" },
        accounts,
        runtimes,
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
      // Local navigation must not wait for provider processes or network calls.
      // Selection below triggers discovery in the actual project context.
      // Open the most recently updated session, or the first project.
      const firstSession = sessions[0];
      if (firstSession !== undefined) {
        await this.selectSession(firstSession.id);
      } else if (projects[0] !== undefined) {
        await this.selectProject(projects[0].id);
      } else {
        void this.reloadModels().catch((error) => this.report(error));
      }
    } catch (error) {
      this.ready = true;
      this.report(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation

  /** Makes one project current without opening a session. */
  async selectProject(projectId: string): Promise<void> {
    if (this.store.get().selection.projectId === projectId) { this.openPage("chat"); return; }
    this.rememberCurrentSession();
    this.store.update((state) => ({
      ...state,
      page: "chat",
      selection: { projectId, sessionId: undefined, runId: undefined },
      session: undefined,
      runs: [],
      transcripts: {},
      journal: undefined,
    }));
    void this.reloadModels().catch((error) => this.report(error));
  }

  /** Opens a session; its project becomes the current project. */
  async selectSession(sessionId: string): Promise<void> {
    if (this.removedSessions.has(sessionId)) return;
    this.rememberCurrentSession();
    const cached = this.sessionCache.get(sessionId);
    const projectId = this.store.get().sessions.find((session) => session.id === sessionId)?.projectId;
    const projectChanged = projectId !== this.store.get().selection.projectId;
    this.store.update((state) => ({
      ...state,
      page: "chat",
      selection: { projectId, sessionId, runId: undefined },
      session: cached?.session,
      runs: cached?.runs ?? [],
      transcripts: cached?.transcripts ?? {},
      journal: undefined,
    }));
    if (projectChanged || !this.modelDiscoveryStarted) void this.reloadModels().catch((error) => this.report(error));
    await Promise.all([
      this.reloadSession(sessionId),
      projectChanged ? this.reloadProjects() : Promise.resolve(),
    ]);
  }

  /** Selects a run for diagnostics and loads its journal; selecting it again clears selection. */
  async selectRun(runId: string): Promise<void> {
    if (this.store.get().selection.runId === runId) {
      this.store.update((state) => ({ ...state, selection: { ...state.selection, runId: undefined } }));
      return;
    }
    this.store.update((state) => ({ ...state, selection: { ...state.selection, runId } }));
    await this.reloadJournal(runId);
  }

  openPage(page: "chat" | "usage" | "pull-requests", reviewProjectId?: string): void {
    this.store.update((state) => ({ ...state, page, ...(reviewProjectId === undefined ? {} : { reviewProjectId }) }));
  }

  /** Shows the right panel with the given tool tab open, e.g. "side-chat". */
  openTool(id: string): void {
    this.store.update((state) => ({ ...state, page: "chat", toolRequest: { id, seq: (state.toolRequest?.seq ?? 0) + 1 } }));
  }

  openSettings(section?: SettingsSection): void {
    this.store.update((state) => ({
      ...state,
      settings: { open: true, section: section ?? state.settings.section },
    }));
  }

  /** Loads per-device renderer preferences; call once before `start`. */
  loadPreferences(): void {
    this.store.update((state) => ({ ...state, enabledPlugins: loadEnabledPlugins(), favoriteModelKeys: loadModelFavorites() }));
  }

  /** Settings owns the choice; catalog refreshes never prune unavailable favorites. */
  setModelFavorite(key: string, favorite: boolean): void {
    this.store.update((state) => {
      if (state.favoriteModelKeys.includes(key) === favorite) return state;
      if (favorite && !state.models.some((model) => modelKey(model) === key)) return state;
      const others = state.favoriteModelKeys.filter((candidate) => candidate !== key);
      const favoriteModelKeys = favorite ? [...others, key] : others;
      saveModelFavorites(favoriteModelKeys);
      return { ...state, favoriteModelKeys };
    });
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
  // Projects and sessions

  /**
   * Creates one project for a chosen folder (native picker or discovered repository).
   * Sessions, model discovery, and runs all use this same project identity.
   * A caller can guard selection when the user may navigate while creation
   * is pending; registration still finishes, but does not steal newer focus.
   */
  async createProject(params: { path: string; startingRevision?: string }, selectIf: () => boolean = () => true): Promise<boolean> {
    const project = await this.registerProject(params);
    if (project === undefined) return false;
    if (selectIf()) await this.selectProject(project.id);
    return true;
  }

  /** Registers a folder for panel-local browsing without navigating the chat. */
  async registerProject(params: { path: string; startingRevision?: string }): Promise<ProjectView | undefined> {
    let project: ProjectView | undefined;
    return this.attempt(async () => {
      project = await this.host.call("projects.create", params);
      await this.reloadProjects();
    }).then((success) => success ? project : undefined);
  }

  /** Creates a session directly from a project row, without a title form. */
  async createSessionForProject(projectId: string): Promise<boolean> {
    const project = this.store.get().projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) return false;
    return this.createSession(project.id);
  }

  async createSession(projectId?: string, title?: string): Promise<boolean> {
    return this.attempt(async () => {
      const session = await this.host.call("sessions.create", {
        ...(projectId === undefined ? {} : { projectId }),
        ...(title === undefined ? {} : { title }),
      });
      await this.reloadSessions();
      await this.selectSession(session.id);
    });
  }

  /** The same conversation moves into a project; native cwd state is reset by Sessions. */
  async attachProject(sessionId: string, projectId?: string): Promise<boolean> {
    return this.attempt(async () => {
      if (projectId === undefined) {
        const path = await this.selectDirectory("Attach a project folder");
        if (path === undefined) return;
        projectId = (await this.host.call("projects.create", { path })).id;
      }
      await this.host.call("sessions.attachProject", { sessionId, projectId });
      this.sessionCache.delete(sessionId);
      await Promise.all([this.reloadProjects(), this.reloadSessions()]);
      await this.selectSession(sessionId);
    });
  }
  listSkills(sessionId: string, runtimeId: string, accountId: string) {
    return this.host.call("skills.list", { sessionId, runtimeId, accountId });
  }
  async openSessionPath(sessionId: string, path = "", chatFiles = false): Promise<void> {
    await this.attempt(async () => { await this.openPath(path || ".", await this.host.call("sessions.directory", { sessionId, chatFiles })); });
  }

  /** Local-history UI uses the same host boundary; no filesystem access in the renderer. */
  discoverSessions(projectId: string): Promise<SessionDiscovery> {
    return this.host.call("sessions.discover", { projectId });
  }

  previewImport(projectId: string, sourceId: string, nativeSessionId: string): Promise<ExternalSessionSnapshot> {
    return this.host.call("sessions.previewImport", { projectId, sourceId, nativeSessionId });
  }

  async importSession(projectId: string, sourceId: string, nativeSessionId: string): Promise<boolean> {
    return this.attempt(async () => {
      const result = await this.host.call("sessions.import", { projectId, sourceId, nativeSessionId });
      await this.reloadSessions();
      await this.selectSession(result.session.id);
    });
  }

  /** Batch import keeps each successful snapshot when another source fails. */
  async importSessions(projectId: string, selected: readonly { sourceId: string; nativeSessionId: string }[]): Promise<{
    imported: readonly { sourceId: string; nativeSessionId: string; sessionId: string }[];
    failed: readonly { sourceId: string; nativeSessionId: string }[];
  }> {
    const imported: { sourceId: string; nativeSessionId: string; sessionId: string }[] = [];
    const failed: { sourceId: string; nativeSessionId: string }[] = [];
    for (const source of selected) {
      try {
        const result = await this.host.call("sessions.import", { projectId, ...source });
        imported.push({ ...source, sessionId: result.session.id });
      } catch {
        failed.push(source);
      }
    }
    if (imported.length > 0) {
      await this.reloadSessions();
      await this.selectSession(imported.at(-1)!.sessionId);
    }
    return { imported, failed };
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

  /** Repeated clicks share a check. New checks clear old observations so a
   * failed request cannot leave a previous success looking current.
   */
  async diagnoseProvider(providerId: string, accountId?: string): Promise<void> {
    const key = JSON.stringify([providerId, accountId ?? null]);
    if (this.store.get().providerDiagnostics[key]?.pending) return;
    const pending = { pending: true };
    this.store.update((state) => ({ ...state, providerDiagnostics: { ...state.providerDiagnostics, [key]: pending } }));
    try {
      const result = await this.host.call("auth.diagnose", { providerId, ...(accountId === undefined ? {} : { accountId }) });
      if (this.store.get().providerDiagnostics[key] !== pending) return;
      this.store.update((state) => ({ ...state, providerDiagnostics: { ...state.providerDiagnostics, [key]: { pending: false, result } } }));
    } catch {
      if (this.store.get().providerDiagnostics[key] !== pending) return;
      this.store.update((state) => ({ ...state, providerDiagnostics: { ...state.providerDiagnostics,
        [key]: { pending: false, error: "Connection check could not complete. Check that the app is online and try again." },
      } }));
    }
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

  /** Native editor discovery is desktop-shell behavior, separate from runtime tools. */
  onBrowserAddressFocus(listener: () => void) { return this.host.onBrowserAddressFocus(listener); }
  listEditors() { return this.host.listEditors(); }
  async resolveEditorTarget(path = ".", base?: string, sessionId?: string): Promise<import("../../contracts/desktop/transport.js").OpenPathRequest> {
    const state = this.store.get();
    const projectPath = base ?? (sessionId === undefined ? state.projects.find((project) => project.id === state.selection.projectId)?.path : undefined);
    const session = sessionId ?? state.selection.sessionId;
    const directory = projectPath ?? (session === undefined ? undefined : await this.host.call("sessions.directory", { sessionId: session }));
    return { path, ...(directory === undefined ? {} : { base: directory }) };
  }
  async openInEditor(editorId: string, target: import("../../contracts/desktop/transport.js").OpenPathRequest): Promise<void> {
    await this.attempt(async () => {
      const result = await this.host.openInEditor({ editorId, ...target });
      if (result === "missing") throw new Error("This file or folder no longer exists.");
      if (result === "unavailable") throw new Error("The editor could not be opened. Choose another application or check its installation.");
      if (result === "invalid") throw new Error("This file or application cannot be opened.");
    });
  }

  /** Opens an http(s) link in the default browser (main refuses other schemes). */
  openExternal(url: string): void {
    if (url.startsWith("https://") || url.startsWith("http://")) window.open(url, "_blank", "noopener");
  }

  /**
   * Opens a path the user clicked. Relative paths resolve against `base`,
   * defaulting to the selected session's project folder. A path that no
   * longer exists is reported as a notice rather than failing silently.
   */
  async openPath(path: string, base?: string): Promise<void> {
    const state = this.store.get();
    try {
      const chatBase = base === undefined && state.session?.projectId === undefined && state.session ? await this.host.call("sessions.directory", { sessionId: state.session.id }) : undefined;
      const projectPath = base ?? chatBase ?? state.projects.find((project) => project.id === (state.session?.projectId ?? state.selection.projectId))?.path;
      const result = await this.host.openPath({ path, ...(projectPath === undefined ? {} : { base: projectPath }) });
      if (result === "missing") this.notify({ kind: "info", message: `${path} was not found.` });
      else if (result === "invalid") this.notify({ kind: "info", message: `${path} cannot be opened.` });
    } catch (error) {
      this.report(error);
    }
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
      // A reconnect rotates the account's runtime context. Drop its old local
      // observation; any check still in flight must not repopulate that result.
      if (connect.accountId !== undefined) {
        const key = JSON.stringify([connect.providerId, connect.accountId]);
        this.store.update((state) => {
          const { [key]: _old, ...providerDiagnostics } = state.providerDiagnostics;
          return { ...state, providerDiagnostics };
        });
      }
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

  // ---------------------------------------------------------------------------
  // Runs

  /** Captures the destination session before opening the dialog, so switching sessions cannot reroute files. */
  async attachFiles(sessionId: string, kind: AttachmentKind, remaining: number): Promise<readonly SessionAttachment[]> {
    try {
      const paths = await this.host.selectFiles(kind);
      if (paths.length === 0) return [];
      if (paths.length > remaining) throw new Error(`You can attach up to ${MAX_ATTACHMENTS} files per message. ${remaining} slots remain.`);
      return await this.host.call("sessions.attachFiles", { sessionId, paths });
    } catch (error) {
      this.report(error);
      return [];
    }
  }

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
      if (error instanceof HostCommandError && error.code === "project_busy") {
        return {
          kind: "error",
          code: error.code,
          message: `This project is being edited by attempt ${error.details["attemptId"] ?? "unknown"}. Retry after it finishes.`,
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
    const stopped = await this.attempt(() => this.host.call("runs.cancel", { runId }).then(() => undefined));
    if (!stopped) this.patchLive(runId, (live) => ({ ...live, cancelRequested: false }));
  }

  async respondToApproval(runId: string, approvalId: string, decision: "allow" | "deny"): Promise<void> {
    await this.attempt(() => this.host.call("runs.respondToApproval", { runId, approvalId, decision }).then(() => undefined));
  }

  async respondToQuestions(runId: string, requestId: string, response: UserQuestionResponse | null): Promise<boolean> {
    return this.attempt(() => this.host.call("runs.respondToQuestions", { runId, requestId, response }).then(() => undefined));
  }

  /** Removal events update every window; also apply locally so fake/offline
   * transports that deliver a command reply first cannot leave stale history.
   */
  async removeSession(sessionId: string, force = false): Promise<boolean> {
    return this.attempt(async () => {
      await this.host.call("sessions.remove", { sessionId, ...(force ? { force: true } : {}) });
      this.forgetSession(sessionId);
    });
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
    // Already-queued IPC from a dead host cannot resurrect loading indicators.
    if (this.store.get().host.status === "exited" && event.type.startsWith("run.")) return;
    const { selection } = this.store.get();
    switch (event.type) {
      case "host.status": {
        if (event.status === "exited") {
          this.sessionCache.clear();
          for (const session of this.store.get().sessions) this.invalidateSession(session.id);
        }
        this.store.update((state) => {
          if (event.status !== "exited") return { ...state, host: { status: event.status } };
          const ended = (run: RunView): RunView => run.status === "running" || run.status === "queued"
            ? { ...run, status: "unknown", error: "The execution host stopped. Restart Rack and review the saved activity before continuing.",
              attempts: run.attempts.map((attempt) => attempt.status === "running" || attempt.status === "queued" ? { ...attempt, status: "unknown" } : attempt) } : run;
          const runs = new Map(state.runs.map((run) => [run.id, ended(run)]));
          const transcripts = { ...state.transcripts };
          for (const live of Object.values(state.live)) if (live.run.sessionId === state.selection.sessionId) {
            runs.set(live.run.id, ended(live.run)); transcripts[live.run.id] = live.events;
          }
          // A dead host cannot own a live handle. Retain activity as uncertain
          // history instead of leaving stop controls and loading dots forever.
          return { ...state, host: { status: "exited", ...(event.detail === undefined ? {} : { detail: event.detail }) }, live: {},
            runs: [...runs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)), transcripts };
        });
        return;
      }
      case "run.started":
        this.invalidateSession(event.run.sessionId);
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
        this.invalidateSession(event.run.sessionId);
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
      case "sessions.changed":
        if (this.removedSessions.has(event.sessionId)) return;
        this.invalidateSession(event.sessionId);
        void this.reloadSessions();
        if (event.sessionId === selection.sessionId) void this.reloadSession(event.sessionId);
        return;
      case "sessions.removed":
        this.forgetSession(event.sessionId);
        return;
      case "timeline.changed":
        for (const listener of [...this.timelineListeners]) listener(event.sessionId);
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
        pendingQuestions: [],
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
      pendingQuestions: event.type === "question_request" ? [...(current.pendingQuestions ?? []), event.request]
        : event.type === "question_resolved" ? (current.pendingQuestions ?? []).filter((request) => request.id !== event.requestId) : current.pendingQuestions ?? [],
    }));
  }

  private finishRun(run: RunView): void {
    this.store.update((state) => {
      const { [run.id]: _finished, ...live } = state.live;
      const runs = state.selection.sessionId === run.sessionId
        ? upsertRun(state.runs, run)
        : state.runs;
      const events = state.live[run.id]?.events;
      const transcripts = state.selection.sessionId === run.sessionId && events !== undefined
        ? { ...state.transcripts, [run.id]: events } : state.transcripts;
      return { ...state, live, runs, transcripts };
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

  /** Refreshes provider-backed models after account or project changes. */
  private reloadModels(): Promise<void> {
    this.modelDiscoveryStarted = true;
    return this.coalesce("models", async () => {
      this.store.update((state) => ({ ...state, modelsLoading: true }));
      try {
      // A chat can be selected while a project's native catalog is loading.
      // Finish that query, discard its reply and drain the current context.
      for (;;) {
        const projectId = this.store.get().selection.projectId;
        const models = await this.host.call("models.list", projectId === undefined ? {} : { projectId });
        if (projectId !== this.store.get().selection.projectId) continue;
        this.store.update((state) => ({ ...state, models: models.models, modelCatalogFailures: models.failures }));
        return;
      }
      } finally { this.store.update((state) => ({ ...state, modelsLoading: false })); }
    });
  }

  /** Keeps the project-only navigator supplied with current folder records. */
  private reloadProjects(): Promise<void> {
    return this.coalesce("projects", async () => {
      const projects = await this.host.call("projects.list", {});
      this.store.update((state) => ({ ...state, projects }));
    });
  }

  private reloadSessions(): Promise<void> {
    return this.coalesce("sessions", async () => {
      const listed = await this.host.call("sessions.list", {});
      const sessions = listed.filter((session) => !this.removedSessions.has(session.id));
      this.store.update((state) => ({ ...state, sessions }));
    });
  }

  /** Load activity only for an explicitly expanded page of the current chat.
   * Stale replies cannot replace another session's cache or current live data. */
  async loadSessionActivity(runIds: readonly string[]): Promise<void> {
    const initial = this.store.get();
    const sessionId = initial.selection.sessionId;
    const revision = sessionId === undefined ? undefined : this.sessionRevisions.get(sessionId);
    const allowed = new Set(initial.runs.map((run) => run.id));
    const ids = runIds.filter((id) => allowed.has(id) && initial.transcripts[id] === undefined && initial.live[id] === undefined);
    const results = await settleInBatches(ids, async (id) => [id, eventsFromJournal(await this.host.call("runs.journal", { runId: id }))] as const);
    this.store.update((state) => {
      if (state.selection.sessionId !== sessionId || (sessionId !== undefined && this.sessionRevisions.get(sessionId) !== revision)) return state;
      const transcripts = { ...state.transcripts };
      for (const result of results) if (result.status === "fulfilled" && state.live[result.value[0]] === undefined) transcripts[result.value[0]] = result.value[1];
      return { ...state, transcripts };
    });
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") this.report(failure.reason);
  }

  private reloadSession(sessionId: string): Promise<void> {
    if (this.removedSessions.has(sessionId)) return Promise.resolve();
    return this.coalesce(`session:${sessionId}`, async () => {
      const revision = this.sessionRevisions.get(sessionId) ?? 0;
      try {
        const [session, runs] = await Promise.all([
          this.host.call("sessions.get", { sessionId }),
          this.host.call("runs.list", { sessionId }),
        ]);
        if (this.removedSessions.has(sessionId) || revision !== (this.sessionRevisions.get(sessionId) ?? 0)) return;
        const cached = this.sessionCache.get(sessionId);
        const current = this.store.get();
        const previousRuns = current.session?.id === sessionId ? current.runs : cached?.runs ?? [];
        const previousEvents = current.session?.id === sessionId ? current.transcripts : cached?.transcripts ?? {};
        const transcripts: Record<string, readonly RuntimeEvent[]> = {};
        for (const run of runs) {
          const previous = previousRuns.find((candidate) => candidate.id === run.id);
          // Only immutable, settled histories may be reused. A newer persisted
          // run or a formerly active run must be re-read after settlement.
          if (previous?.updatedAt === run.updatedAt && previous.status === run.status &&
            run.status !== "queued" && run.status !== "running" && previousEvents[run.id] !== undefined) {
            transcripts[run.id] = previousEvents[run.id]!;
          }
        }
        // Publish prompts/final replies as soon as metadata arrives. Activity
        // restoration runs in the background instead of gating every message.
        const publish = () => {
          if (this.removedSessions.has(sessionId) || revision !== (this.sessionRevisions.get(sessionId) ?? 0)) return;
          this.rememberSession({ session, runs, transcripts: { ...transcripts } });
          this.store.update((state) => state.selection.sessionId === sessionId ? {
            ...state, session, runs, transcripts: { ...transcripts },
          } : state);
        };
        publish();
        const saved = await settleInBatches(runs.slice(-50), async (run) => {
          if (this.store.get().live[run.id] !== undefined) return [run.id, undefined] as const;
          if (transcripts[run.id] !== undefined) return [run.id, transcripts[run.id]!] as const;
          return [run.id, eventsFromJournal(await this.host.call("runs.journal", { runId: run.id }))] as const;
        });
        let restored = false;
        for (const result of saved) {
          if (result.status === "fulfilled" && result.value[1] !== undefined && transcripts[result.value[0]] !== result.value[1]) {
            transcripts[result.value[0]] = result.value[1];
            restored = true;
          }
        }
        if (restored) publish();
        const failure = saved.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      } catch (error) {
        if (error instanceof HostCommandError && error.code === "session_not_found") this.forgetSession(sessionId);
        if (!this.removedSessions.has(sessionId)) throw error;
      } finally {
        // A live run can finish while old metadata/journals are in flight.
        // Discard that load and retry after coalescing releases its promise.
        if (!this.removedSessions.has(sessionId) && revision !== (this.sessionRevisions.get(sessionId) ?? 0)) setTimeout(() => {
          if (this.store.get().selection.sessionId === sessionId) void this.reloadSession(sessionId);
        }, 0);
      }
    });
  }

  private invalidateSession(sessionId: string): void {
    this.sessionRevisions.set(sessionId, (this.sessionRevisions.get(sessionId) ?? 0) + 1);
  }

  private forgetSession(sessionId: string): void {
    this.removedSessions.add(sessionId);
    this.invalidateSession(sessionId);
    this.sessionCache.delete(sessionId); this.sessionCacheSizes.delete(sessionId);
    this.store.update((state) => ({
      ...state,
      sessions: state.sessions.filter((session) => session.id !== sessionId),
      ...(state.selection.sessionId !== sessionId ? {} : {
        selection: { projectId: state.selection.projectId, sessionId: undefined, runId: undefined },
        session: undefined, runs: [], transcripts: {}, journal: undefined,
      }),
    }));
  }

  private rememberCurrentSession(): void {
    const state = this.store.get();
    if (state.session?.id === state.selection.sessionId && state.session !== undefined) {
      this.rememberSession({ session: state.session, runs: state.runs, transcripts: state.transcripts });
    }
  }

  private rememberSession(value: CachedSession): void {
    this.sessionCache.delete(value.session.id);
    this.sessionCacheSizes.delete(value.session.id);
    // Bound retained payload, not just conversation count. Counting strings
    // avoids serializing a large transcript solely to estimate its size.
    const bytes = retainedBytes(value);
    if (bytes > 32 * 1024 * 1024) return;
    this.sessionCache.set(value.session.id, value);
    this.sessionCacheSizes.set(value.session.id, bytes);
    while (this.sessionCache.size > SESSION_CACHE_LIMIT || [...this.sessionCacheSizes.values()].reduce((sum, size) => sum + size, 0) > 32 * 1024 * 1024) {
      const id = this.sessionCache.keys().next().value!;
      this.sessionCache.delete(id); this.sessionCacheSizes.delete(id);
    }
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
    case "project_busy":
      return { ...base, message: `Project is being edited by attempt ${error.details["attemptId"] ?? "unknown"}. Retry after it finishes.` };
    case "session_busy":
      return { ...base, message: "Stop this session's active run before removing it." };
    case "file_conflict":
      return { ...base, message: "This file changed on disk. Reload before saving; your draft is kept." };
    case "account_not_found":
    case "project_not_found":
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
    case "feature_unavailable":
      return { ...base, message: "This feature is not available in this version of the app." };
    case "timeline_busy":
      return { ...base, message: "Stop the current run before changing timeline settings." };
    case "timeline_unsupported":
      return { ...base, message: "Timeline is not supported for this project." };
    case "snapshot_not_found":
      return { ...base, message: "No snapshot for this action. Refresh the timeline." };
    case "snapshot_path_invalid":
      return { ...base, message: "File is not part of this snapshot." };
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
      pendingQuestions: view.pendingQuestions ?? [],
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

/** Limit history IPC and host work while retaining independent failures. */
async function settleInBatches<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let index = 0; index < items.length; index += 4) results.push(...await Promise.allSettled(items.slice(index, index + 4).map(task)));
  return results;
}

/** Approximate owned JS payload; shared references are counted once per entry. */
function retainedBytes(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value === "string") return value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  if (seen.has(value)) return 0;
  seen.add(value);
  let size = 32;
  for (const child of Object.values(value)) size += retainedBytes(child, seen);
  return size;
}
