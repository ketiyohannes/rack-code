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
 * - refusing to start a run on a shared workspace that already has a writer,
 *   so the UI gets `workspace_busy` with the owning attempt instead of a
 *   failed run (the core lock remains the authoritative guard);
 * - reporting whether the Accounts service fell back from the selected
 *   account when the caller did not name one.
 */
import type { AccountRecord } from "../../core/accounts/types.js";
import type { AccountsService } from "../../core/accounts/service.js";
import type { ExecutionService } from "../../core/execution/service.js";
import type { RuntimeRegistry } from "../../core/execution/runtime-registry.js";
import type { RunRecord } from "../../core/execution/types.js";
import type { ProjectsService } from "../../core/projects/service.js";
import type { ConnectionsService } from "../../core/connections/service.js";
import type { SessionsService } from "../../core/sessions/service.js";
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
  type ModelView,
  type RunView,
  type SessionSummaryView,
} from "../../contracts/desktop/views.js";
import { ActiveRuns } from "./active-runs.js";
import { HostOperationError, toHostError } from "./errors.js";

/** The application services the host needs; satisfied by `createApplication`. */
export interface HostApplication {
  readonly accounts: AccountsService;
  readonly projects: ProjectsService;
  readonly sessions: SessionsService;
  readonly execution: ExecutionService;
  readonly connections: ConnectionsService;
  readonly runtimes: RuntimeRegistry;
}

type Handlers = {
  readonly [C in HostCommand]: (params: CommandParams<C>) => Promise<CommandResult<C>>;
};

export class HostApi {
  private readonly activeRuns: ActiveRuns;
  private readonly handlers: Handlers;

  constructor(
    private readonly app: HostApplication,
    private readonly emit: (event: HostEvent) => void,
  ) {
    this.activeRuns = new ActiveRuns({ emit, loadRun: (runId) => this.loadRun(runId) });
    this.handlers = this.createHandlers();
    // Sign-in progress is pushed to every client; a completed sign-in also
    // changed account records.
    app.connections.subscribe((connect) => {
      emit({ type: "auth.updated", connect });
      if (connect.status === "completed") emit({ type: "accounts.changed" });
    });
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
      const handler = this.handlers[command] as (input: typeof validated) => Promise<unknown>;
      return { ok: true, value: await handler(validated) };
    } catch (error) {
      return { ok: false, error: toHostError(error) };
    }
  }

  /** Stop-on-exit: cancels sign-ins, then runs (see `ActiveRuns.cancelAll`). */
  async shutdown(timeoutMs: number): Promise<number> {
    await this.app.connections.cancelAll();
    return this.activeRuns.cancelAll(timeoutMs);
  }

  private createHandlers(): Handlers {
    const { accounts, projects, sessions, execution, runtimes, connections } = this.app;
    return {
      "auth.providers": async () => connections.providers(),
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
        this.emit({ type: "projects.changed" });
        return project;
      },
      "workspaces.list": async (params) => projects.listWorkspaces(params.projectId),
      "workspaces.create": async (params) => {
        const workspace = await projects.createWorkspace(params);
        this.emit({ type: "workspaces.changed", projectId: workspace.projectId });
        return workspace;
      },

      "sessions.list": async (params) => (await sessions.list(params.projectId)).map(
        (session): SessionSummaryView => ({
          id: session.id,
          projectId: session.projectId,
          workspaceId: session.workspaceId,
          ...(session.title === undefined ? {} : { title: session.title }),
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }),
      ),
      "sessions.create": async (params) => {
        // Validate references up front so a session cannot point at a
        // workspace from another project.
        const workspace = await projects.getWorkspace(params.workspaceId);
        if (workspace.projectId !== params.projectId) {
          throw new HostOperationError(
            "workspace_project_mismatch",
            `Workspace '${params.workspaceId}' does not belong to project '${params.projectId}'.`,
          );
        }
        const session = await sessions.create(params);
        this.emit({ type: "sessions.changed", projectId: session.projectId, sessionId: session.id });
        return session;
      },
      "sessions.get": async (params) => sessions.get(params.sessionId),

      "runtimes.list": async () => runtimes.list().map((runtimeId) => {
        const runtime = runtimes.get(runtimeId);
        const permissionMappings = Object.fromEntries(
          PERMISSION_MODES.map((mode) => [mode, runtime.describePermissionMode(mode)]),
        ) as Record<PermissionMode, string>;
        return {
          runtimeId,
          ...(runtime.providerId === undefined ? {} : { providerId: runtime.providerId }),
          permissionMappings,
        };
      }),
      "runtimes.capabilities": async (params) => {
        const account = await accounts.get(params.accountId);
        return runtimes.get(params.runtimeId).capabilities({
          accountId: account.id,
          providerId: account.providerId,
          credential: account.credential,
          runtimeContextId: account.runtimeContextId,
        });
      },
      "models.list": async () => this.listModels(),

      "runs.start": async (params) => {
        const workspace = await projects.getWorkspace(params.workspaceId);
        if (workspace.activeWriterAttemptId !== undefined) {
          throw new HostOperationError(
            "workspace_busy",
            `Workspace '${workspace.id}' is already being edited by attempt '${workspace.activeWriterAttemptId}'.`,
            { workspaceId: workspace.id, attemptId: workspace.activeWriterAttemptId },
          );
        }
        // Read the selection before starting so a fallback can be reported.
        const selected = params.accountId === undefined
          ? await accounts.selected(params.providerId)
          : undefined;
        const handle = await execution.start(params);
        const run = await this.loadRun(handle.runId);
        const fallbackFromAccountId = selected !== undefined && selected.id !== run.accountId
          ? selected.id
          : undefined;
        this.activeRuns.track(handle, run, fallbackFromAccountId);
        const started = {
          run,
          ...(fallbackFromAccountId === undefined ? {} : { fallbackFromAccountId }),
        };
        this.emit({ type: "run.started", ...started });
        this.emit({ type: "accounts.changed" });
        return started;
      },
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
    };
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

  /**
   * Builds one provider-neutral model catalog. Runtime IDs never cross into
   * the renderer as a user choice; they remain attached to each model so the
   * host can route the selected model to the correct adapter at run start.
   */
  private async listModels(): Promise<readonly ModelView[]> {
    const allAccounts = await this.app.accounts.list();
    const selectedByProvider = new Map<string, AccountRecord | undefined>();
    for (const providerId of new Set(allAccounts.map((account) => account.providerId))) {
      selectedByProvider.set(providerId, await this.app.accounts.selected(providerId));
    }

    const models = await Promise.all(this.app.runtimes.list().map(async (runtimeId) => {
      const runtime = this.app.runtimes.get(runtimeId);
      if (runtime.models === undefined) return [] as ModelView[];
      const providerId = runtime.providerId ?? runtimeId;
      const account = selectedByProvider.get(providerId);
      const discovered = await runtime.models(account === undefined ? undefined : {
        accountId: account.id,
        providerId: account.providerId,
        credential: account.credential,
        runtimeContextId: account.runtimeContextId,
      });
      return discovered.map((model): ModelView => ({
        ...model,
        providerId,
        runtimeId,
      }));
    }));
    const seen = new Set<string>();
    return models.flat().filter((model) => {
      const key = `${model.providerId}\u0000${model.runtimeId}\u0000${model.modelId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
    return { ...run, attempts };
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
