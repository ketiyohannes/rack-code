import type { ReviewInboxService } from "../../features/pull-requests/index.js";
import type { PullRequestsService } from "../../features/pull-requests/index.js";
import type { UsageService } from "../../features/usage/index.js";
/**
 * Transport-independent command dispatcher for the execution host.
 *
 * `HostApi.dispatch` validates untrusted parameters against the desktop
 * contract, calls the owning application service, and maps results to
 * serializable views. It knows nothing about Electron, so it is exercised
 * directly by headless tests and could be reused by a future remote host.
 *
 * Responsibilities kept here (and not in the renderer):
 * - stripping credential references and runtime-context IDs from accounts;
 * - refusing to start a run on a shared project that already has a writer,
 *   so the UI gets `project_busy` with the owning attempt instead of a
 *   failed run (the core lock remains the authoritative guard);
 * - reporting whether the Accounts service fell back from the selected
 *   account when the caller did not name one;
 * - connecting optional features that were assembled at startup. Timeline,
 *   when present, captures the run-start observation before a run starts and
 *   observes the run's events through `ActiveRuns`. Its commands answer
 *   `feature_unavailable` when it was not assembled.
 */
import type { AccountRecord } from "../../core/accounts/types.js";
import type { AccountsService } from "../../core/accounts/service.js";
import type { ExecutionService } from "../../core/execution/service.js";
import type { RuntimeRegistry } from "../../core/execution/runtime-registry.js";
import type { RunRecord } from "../../core/execution/types.js";
import type { ProjectsService } from "../../core/projects/service.js";
import type { ConnectionsService } from "../../core/connections/service.js";
import type { SessionsService } from "../../core/sessions/service.js";
import type { SessionImportsService } from "../../core/session-imports/service.js";
import type { TimelineService } from "../../features/timeline/index.js";
import {
  isHostCommand,
  validateCommandParams,
  type CommandParams,
  type CommandResult,
  type HostCommand,
} from "../../contracts/desktop/commands.js";
import type { HostEvent } from "../../contracts/desktop/events.js";
import type { CommandResponse } from "../../contracts/desktop/transport.js";
import {
  PERMISSION_MODES,
  type AccountView,
  type PermissionMode,
  type RunView,
  type SessionSummaryView,
} from "../../contracts/desktop/views.js";
import { ActiveRuns } from "./active-runs.js";
import { HostOperationError, toHostError } from "./errors.js";
import type { FilesService } from "../../features/files/index.js";
import type { TerminalBackend, TerminalService } from "../../features/terminal/index.js";
import type { BrowserService } from "../../features/browser/index.js";

/** The application services the host needs; satisfied by `createApplication`. */
export interface HostApplication {
  readonly pullRequests?: PullRequestsService;
  readonly reviewInbox?: ReviewInboxService;
  readonly usage?: UsageService;
  readonly accounts: AccountsService;
  readonly projects: ProjectsService;
  readonly sessions: SessionsService;
  readonly sessionImports: SessionImportsService;
  readonly execution: ExecutionService;
  readonly connections: ConnectionsService;
  readonly runtimes: RuntimeRegistry;
  /** Optional feature; absent when startup composition did not assemble it. */
  readonly timeline?: TimelineService;
  readonly files?: FilesService;
  readonly terminal?: TerminalService;
  readonly browser?: BrowserService;
}

type Handlers = {
  readonly [C in HostCommand]: (params: CommandParams<C>) => Promise<CommandResult<C>>;
};

export class HostApi {
  private readonly activeRuns: ActiveRuns;
  private readonly ready: Promise<void>;
  private stopping = false;
  private readonly handlers: Handlers;
  /** Prevent removal from racing a run start before its handle is tracked. */
  private readonly sessionMutations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly app: HostApplication,
    private readonly emit: (event: HostEvent) => void,
  ) {
    this.ready = app.execution.initialize();
    void this.ready.catch(() => {});
    this.activeRuns = new ActiveRuns({ emit, loadRun: (runId) => this.loadRun(runId) });
    this.handlers = this.createHandlers();
    // Sign-in progress is pushed to every client; a completed sign-in also
    // changed account records.
    app.connections.subscribe((connect) => {
      emit({ type: "auth.updated", connect });
      if (connect.status === "completed") emit({ type: "accounts.changed" });
    });
    app.timeline?.subscribe((sessionId) => emit({ type: "timeline.changed", sessionId }));
  }

  /**
   * Executes one command from an untrusted client. Never throws: failures
   * are returned as `{ ok: false, error }` with a stable code.
   */
  async dispatch(command: unknown, params: unknown): Promise<CommandResponse> {
    try {
      if (!isHostCommand(command)) {
        throw new HostOperationError("unknown_command", `Unknown command '${String(command)}'.`);
      }
      const validated = validateCommandParams(command, params);
      await this.ready;
      const handler = this.handlers[command] as (input: typeof validated) => Promise<unknown>;
      return { ok: true, value: await handler(validated) };
    } catch (error) {
      return { ok: false, error: toHostError(error) };
    }
  }

  /** Stop-on-exit: cancels sign-ins, then runs (see `ActiveRuns.cancelAll`). */
  async shutdown(timeoutMs: number): Promise<number> {
    this.stopping = true;
    // Start cancellation before optional cleanup or queued mutations can stall it.
    const stoppingRuns = this.activeRuns.cancelAll(timeoutMs);
    const stoppingTracking = this.app.timeline?.stopProjectTracking();
    await this.app.connections.cancelAll();
    await Promise.allSettled([...this.sessionMutations.values()]);
    const remaining = await stoppingRuns;
    await stoppingTracking;
    await this.app.terminal?.shutdown();
    return remaining;
  }

  private createHandlers(): Handlers {
    const { accounts, projects, sessions, sessionImports, execution, runtimes, connections } = this.app;
    const reviews = () => {
      if (!this.app.pullRequests) throw new HostOperationError("feature_unavailable", "Pull requests are unavailable in this host.");
      return this.app.pullRequests;
    };
    const inbox = () => {
      if (!this.app.reviewInbox) throw new HostOperationError("feature_unavailable", "The account review inbox is unavailable in this host.");
      return this.app.reviewInbox;
    };
    return {
      "reviews.accounts": async (p) => inbox().accounts(p.refresh),
      "reviews.accountConnect": async (p) => inbox().connect(p.host, p.token),
      "reviews.inbox": async (p) => inbox().list(p),
      "reviews.inboxRepository": async (p) => inbox().repositoryList(p, p.query, p.state, p.page),
      "reviews.inboxCreate": async (p) => inbox().create(p, p.input),
      "reviews.inboxDetail": async (p) => {
        const detail = await inbox().detail(p);
        if (detail.timelineCheckpointId) this.emit({ type: "timeline.changed", sessionId: "" });
        return detail;
      },
      "reviews.inboxAct": async (p) => { await inbox().act(p, p.action, p.body, p.head); return null; },
      "reviews.inboxSync": async (p) => {
        const result = await inbox().sync(p, p.projectId);
        this.emit({ type: "timeline.changed", sessionId: "" });
        return result;
      },
      "reviews.repositories": async (p) => reviews().repositories(p.projectId),
      "reviews.connect": async (p) => { await reviews().connect(p.projectId, p.remote, p.token); return null; },
      "reviews.list": async (p) => reviews().list(p.projectId, p.remote, p.query, p.state, p.page),
      "reviews.detail": async (p) => {
        const detail = await reviews().detail(p.projectId, p.remote, p.id);
        if (detail.timelineCheckpointId) this.emit({ type: "timeline.changed", sessionId: "" });
        return detail;
      },
      "reviews.create": async (p) => reviews().create(p.projectId, p.remote, p.input),
      "reviews.act": async (p) => { await reviews().act(p.projectId, p.remote, p.id, p.action, p.body, p.head); this.emit({ type: "timeline.changed", sessionId: "" }); return null; },
      "reviews.publish": async (p) => { await reviews().publish(p.projectId, p.remote, p.branch); return null; },
      "reviews.sync": async (p) => {
        const checkpointId = await reviews().sync(p.projectId, p.remote, p.id);
        this.emit({ type: "timeline.changed", sessionId: "" });
        return { checkpointId };
      },
      "usage.report": async (p) => {
        if (!this.app.usage) throw new HostOperationError("feature_unavailable", "Usage is unavailable in this host.");
        if (p.projectId) await projects.getProject(p.projectId);
        return this.app.usage.report(p);
      },
      "files.list": async (params) => this.files().list(params.projectId, params.path),
      "files.read": async (params) => this.files().read(params.projectId, params.path),
      "files.save": async (params) => this.files().save(params.projectId, params.path, params.text, params.version),
      "terminal.open": async (params) => this.mutateSession(params.sessionId ?? `project:${params.projectId}`, async () => {
        const project = await projects.getProject(params.projectId);
        if (params.sessionId !== undefined && (await sessions.get(params.sessionId)).projectId !== project.id) throw new HostOperationError("invalid_input", "Terminal project does not match the selected session.");
        let native: TerminalBackend | undefined;
        if (params.sessionId !== undefined) {
          const run = [...await execution.listRuns(params.sessionId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (run !== undefined) {
            try {
              const attemptId = run.attemptIds.at(-1);
              const runtime = attemptId === undefined ? undefined : runtimes.get((await execution.getAttempt(attemptId)).runtimeId);
              if (runtime?.openTerminal !== undefined) {
                const account = await accounts.get(run.accountId);
                native = { label: "Provider terminal", start: (input) => runtime.openTerminal!({ ...input, account: {
                  accountId: account.id, providerId: account.providerId, credential: account.credential, runtimeContextId: account.runtimeContextId,
                } }) };
              }
            } catch { /* Missing historical runtime/account can use the local shell. */ }
          }
        }
        return this.terminals().open(params.sessionId === undefined ? `project:${project.id}` : `session:${params.sessionId}`, project.path, params.cols, params.rows, native);
      }),
      "terminal.read": async (params) => this.terminals().read(params.terminalId, params.after),
      "terminal.write": async (params) => { await this.terminals().write(params.terminalId, params.data); return null; },
      "terminal.resize": async (params) => { await this.terminals().resize(params.terminalId, params.cols, params.rows); return null; },
      "terminal.close": async (params) => { await this.terminals().close(params.terminalId); return null; },
      "browser.control": async (params) => this.mutateSession(params.sessionId, async () => {
        if (this.app.browser === undefined) throw new HostOperationError("feature_unavailable", "The shared browser requires the desktop app.");
        return this.app.browser.control(params.sessionId, params.request);
      }),
      "projects.changes": async (params) => projects.getChanges(params.projectId, params.repositoryPath),
      "projects.repositories": async ({ projectId, ...options }) => projects.discoverRepositories(projectId, options),
      "auth.providers": async () => connections.providers(),
      "auth.diagnose": async (params) => connections.diagnose(params),
      "auth.connect": async (params) => connections.connect(params),
      "auth.submitCode": async (params) => {
        connections.submitCode(params.connectId, params.code);
        return null;
      },
      "auth.cancel": async (params) => {
        await connections.cancel(params.connectId);
        return null;
      },
      "auth.active": async () => connections.active(),
      "accounts.list": async () => this.listAccounts(),
      "accounts.register": async (params) => {
        const account = await accounts.register({
          providerId: params.providerId,
          identity: {
            providerAccountId: params.providerAccountId,
            ...(params.email === undefined ? {} : { email: params.email }),
            ...(params.displayName === undefined ? {} : { displayName: params.displayName }),
          },
          credential: params.credential,
          runtimeContextId: params.runtimeContextId,
        });
        this.emit({ type: "accounts.changed" });
        return this.accountView(account);
      },
      "accounts.select": async (params) => {
        const account = await accounts.select(params.providerId, params.accountId);
        this.emit({ type: "accounts.changed" });
        return this.accountView(account);
      },
      "accounts.reauthenticate": async (params) => {
        const account = await accounts.reauthenticate(params.accountId, {
          credential: params.credential,
          ...(params.runtimeContextId === undefined ? {} : { runtimeContextId: params.runtimeContextId }),
        });
        this.emit({ type: "accounts.changed" });
        return this.accountView(account);
      },

      "projects.list": async () => projects.listProjects(),
      "projects.create": async (params) => {
        const project = await projects.createProject(params);
        void this.app.timeline?.refreshProjects();
        this.emit({ type: "projects.changed" });
        return project;
      },

      "sessions.list": async (params) => {
        const projectId = params.projectId === undefined ? undefined : (await projects.getProject(params.projectId)).id;
        return (await sessions.list(projectId)).map(
        (session): SessionSummaryView => ({
          id: session.id,
          projectId: session.projectId,
          ...(session.title === undefined ? {} : { title: session.title }),
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }),
        );
      },
      "sessions.create": async (params) => {
        // Validate the project before persisting the session.
        const project = await projects.getProject(params.projectId);
        const session = await sessions.create({ ...params, projectId: project.id });
        this.emit({ type: "sessions.changed", projectId: session.projectId, sessionId: session.id });
        return session;
      },
      "sessions.get": async (params) => sessions.get(params.sessionId),
      "sessions.attachFiles": async (params) => this.mutateSession(params.sessionId, () => sessions.attachFiles(params.sessionId, params.paths)),
      "sessions.remove": async ({ sessionId, force }) => this.mutateSession(sessionId, async () => {
        const session = await sessions.get(sessionId);
        if (force === true) await this.activeRuns.cancelSession(sessionId, 8000);
        const runs = await execution.listRuns(sessionId);
        if (this.activeRuns.list().some((active) => active.run.sessionId === sessionId) ||
          runs.some((run) => run.status === "queued" || run.status === "running")) {
          throw new HostOperationError("session_busy", "Stop this session's active run before removing it.", { sessionId });
        }
        await this.app.terminal?.closeContext(`session:${sessionId}`);
        await sessions.remove(sessionId);
        this.emit({ type: "sessions.removed", projectId: session.projectId, sessionId });
        return null;
      }),
      "sessions.discover": async (params) => sessionImports.discover(params.projectId),
      "sessions.previewImport": async (params) => {
        const snapshot = await sessionImports.preview(params.projectId, params.sourceId, params.nativeSessionId);
        // Preview the latest visible conversation with bounded transport data.
        // Import itself re-reads and saves the complete snapshot.
        return { ...snapshot, messages: snapshot.messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-12).map((message) => ({
          ...message, content: message.content.slice(0, 4000),
        })) };
      },
      "sessions.import": async (params) => {
        const result = await sessionImports.import(params.projectId, params.sourceId, params.nativeSessionId);
        this.emit({ type: "sessions.changed", projectId: result.session.projectId, sessionId: result.session.id });
        return result;
      },

      "runtimes.list": async () => runtimes.list().map((runtimeId) => {
        const runtime = runtimes.get(runtimeId);
        const permissionMappings = Object.fromEntries(
          PERMISSION_MODES.map((mode) => [mode, runtime.describePermissionMode(mode)]),
        ) as Record<PermissionMode, string>;
        return { runtimeId, ...(runtime.providerId === undefined ? {} : { providerId: runtime.providerId }), permissionMappings };
      }),
      "models.list": async (params) => {
        // Discovery runs in the selected project when one is available so
        // providers see the same working directory that a subsequent run
        // will use. The catalog remains account-scoped and never receives
        // renderer credentials or provider SDK objects.
        const projectPath = params.projectId === undefined
          ? undefined
          : (await projects.getProject(params.projectId)).path;
        const providerNames = new Map(connections.providers().map((provider) => [provider.providerId, provider.displayName]));
        const accountsByProvider = new Map<string, AccountRecord[]>();
        for (const account of await accounts.list()) {
          const list = accountsByProvider.get(account.providerId) ?? [];
          list.push(account);
          accountsByProvider.set(account.providerId, list);
        }
        const models = new Map<string, { readonly model: import("../../core/execution/types.js").RuntimeModel; readonly runtimeId: string; readonly accountIds: string[] }>();
        const failures: { readonly providerName: string; readonly accountId: string }[] = [];
        for (const runtimeId of runtimes.list()) {
          const runtime = runtimes.get(runtimeId);
          if (runtime.models === undefined || runtime.providerId === undefined) continue;
          for (const account of accountsByProvider.get(runtime.providerId) ?? []) {
            try {
              const entries = await runtime.models({
                account: { accountId: account.id, providerId: account.providerId, credential: account.credential, runtimeContextId: account.runtimeContextId },
                ...(projectPath === undefined ? {} : { projectPath }),
              });
              for (const model of entries) {
                const key = `${runtimeId}|${model.providerId}|${model.id}`;
                const current = models.get(key);
                if (current === undefined) models.set(key, { model, runtimeId, accountIds: [account.id] });
                else if (!current.accountIds.includes(account.id)) current.accountIds.push(account.id);
              }
            } catch {
              failures.push({ providerName: providerNames.get(account.providerId) ?? account.providerId, accountId: account.id });
            }
          }
        }
        return {
          models: [...models.values()].map(({ model, runtimeId, accountIds }) => ({
            ...model, runtimeId, accountIds: [...accountIds], providerName: providerNames.get(model.providerId) ?? model.providerId,
          })),
          failures,
        };
      },
      "runtimes.capabilities": async (params) => {
        const account = await accounts.get(params.accountId);
        return runtimes.get(params.runtimeId).capabilities({
          accountId: account.id,
          providerId: account.providerId,
          credential: account.credential,
          runtimeContextId: account.runtimeContextId,
        });
      },

      "runs.start": async (params) => this.mutateSession(params.sessionId, async () => {
        if (this.stopping) throw new HostOperationError("host_unavailable", "The app is shutting down.");
        const project = await projects.getProject(params.projectId);
        if (project.activeWriterAttemptId !== undefined) {
          throw new HostOperationError(
            "project_busy",
            `Project '${project.id}' is already being edited by attempt '${project.activeWriterAttemptId}'.`,
            { projectId: project.id, attemptId: project.activeWriterAttemptId },
          );
        }
        // Read the selection before starting so a fallback can be reported.
        const selected = params.accountId === undefined
          ? await accounts.selected(params.providerId)
          : undefined;
        // Timeline (optional) records the run-start state before the runtime
        // can edit files. It resolves to undefined when the session has not
        // opted in, and never rejects, so it cannot prevent the run.
        const observer = await this.app.timeline?.beginRun({ sessionId: params.sessionId });
        let handle: Awaited<ReturnType<typeof execution.start>>;
        try {
          if (this.stopping) throw new HostOperationError("host_unavailable", "The app is shutting down.");
          handle = await execution.start(params);
        } catch (error) {
          observer?.abandon();
          throw error;
        }
        observer?.bindRun(handle.runId);
        let run: RunView;
        try {
          if (this.stopping) throw new HostOperationError("host_unavailable", "The app is shutting down.");
          run = await this.loadRun(handle.runId);
          if (this.stopping) throw new HostOperationError("host_unavailable", "The app is shutting down.");
        } catch (error) {
          // A failed start reply must not strand an untracked provider process.
          try { await handle.cancel(); await handle.completed; } finally { observer?.abandon(); }
          throw error;
        }
        const fallbackFromAccountId = selected !== undefined && selected.id !== run.accountId
          ? selected.id
          : undefined;
        this.activeRuns.track(handle, run, fallbackFromAccountId, observer);
        const started = {
          run,
          ...(fallbackFromAccountId === undefined ? {} : { fallbackFromAccountId }),
        };
        this.emit({ type: "run.started", ...started });
        this.emit({ type: "accounts.changed" });
        return started;
      }),
      "runs.list": async (params) => {
        const runs = await execution.listRuns(params.sessionId);
        return Promise.all(runs.map((run) => this.runView(run)));
      },
      "runs.journal": async (params) => execution.listJournal(params.runId),
      "runs.active": async () => this.activeRuns.list(),
      "runs.respondToApproval": async (params) => {
        this.activeRuns.respondToApproval(params.runId, params.approvalId, params.decision);
        return null;
      },
      "runs.cancel": async (params) => {
        await this.activeRuns.cancel(params.runId);
        return null;
      },
      "runs.respondToQuestions": async (params) => {
        await this.activeRuns.respondToQuestions(params.runId, params.requestId, params.response);
        return null;
      },

      "timeline.status": async (params) => this.timeline().status(params.sessionId),
      "timeline.setEnabled": async (params) => this.timeline().setEnabled(params.sessionId, params.enabled),
      "timeline.checkpoints": async (params) => this.timeline().checkpoints(params.sessionId),
      "timeline.projectHistory": async (params) => this.timeline().projectHistory(params.projectId),
      "timeline.setProjectEnabled": async (params) => this.timeline().setProjectEnabled(params.projectId, params.enabled),
      "timeline.snapshot": async (params) => this.timeline().snapshot(params),
      "timeline.snapshotHistory": async (params) => this.timeline().snapshotHistory(params),
      "timeline.snapshotFile": async (params) => this.timeline().snapshotFile(params, params.path),
      "timeline.projectFileDiff": async (params) => this.timeline().projectFileDiff(params.projectId, params.checkpointId, params.path),
      "timeline.fileDiff": async (params) => this.timeline().fileDiff(params.sessionId, params.checkpointId, params.path),
    };
  }

  /** Host commands can arrive from several windows. Serialize mutations of
   * one conversation while allowing independent sessions to proceed.
   * A failed operation releases the lane instead of poisoning later commands.
   */
  private async mutateSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.sessionMutations.set(sessionId, current);
    try { return await current; }
    finally { if (this.sessionMutations.get(sessionId) === current) this.sessionMutations.delete(sessionId); }
  }

  private files(): FilesService { if (this.app.files === undefined) throw new HostOperationError("feature_unavailable", "Files is not available."); return this.app.files; }
  private terminals(): TerminalService { if (this.app.terminal === undefined) throw new HostOperationError("feature_unavailable", "Terminal is not available."); return this.app.terminal; }

  /** The assembled Timeline feature, or `feature_unavailable`. */
  private timeline(): TimelineService {
    if (this.app.timeline === undefined) {
      throw new HostOperationError("feature_unavailable", "Timeline is not available in this application.");
    }
    return this.app.timeline;
  }

  private async listAccounts(): Promise<readonly AccountView[]> {
    const all = await this.app.accounts.list();
    const counts = this.activeRuns.countByAccount();
    const selectedByProvider = new Map<string, string | undefined>();
    for (const providerId of new Set(all.map((account) => account.providerId))) {
      selectedByProvider.set(providerId, (await this.app.accounts.selected(providerId))?.id);
    }
    return all.map((account) => toAccountView(
      account,
      selectedByProvider.get(account.providerId) === account.id,
      counts.get(account.id) ?? 0,
    ));
  }

  private async accountView(account: AccountRecord): Promise<AccountView> {
    const selected = await this.app.accounts.selected(account.providerId);
    return toAccountView(account, selected?.id === account.id, this.activeRuns.countByAccount().get(account.id) ?? 0);
  }

  private async loadRun(runId: string): Promise<RunView> {
    return this.runView(await this.app.execution.getRun(runId));
  }

  private async runView(run: RunRecord): Promise<RunView> {
    const attempts = await Promise.all(run.attemptIds.map((id) => this.app.execution.getAttempt(id)));
    // A failed terminal save can leave a pending durable status even after
    // the handle ended. Never render that orphan as actionable live work.
    const orphan = (run.status === "queued" || run.status === "running") && !this.app.execution.isActive(run.id);
    return { ...run, attempts, ...(orphan ? { status: "unknown" as const, error: "Run ended without a saved final outcome. Review the activity before continuing." } : {}) };
  }
}

/** Copies only display-safe fields; credential and runtime context stay in the host. */
function toAccountView(account: AccountRecord, selected: boolean, activeAttempts: number): AccountView {
  return {
    id: account.id,
    providerId: account.providerId,
    identity: { ...account.identity },
    availability: account.availability,
    ...(account.availabilityReason === undefined ? {} : { availabilityReason: account.availabilityReason }),
    ...(account.quotaResetAt === undefined ? {} : { quotaResetAt: account.quotaResetAt }),
    ...(account.lastUsedAt === undefined ? {} : { lastUsedAt: account.lastUsedAt }),
    createdAt: account.createdAt,
    selected,
    activeAttempts,
  };
}
