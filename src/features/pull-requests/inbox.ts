/** Account-wide review contracts. Credentials stay behind the gateway, never in desktop views. */
import type { CreatePull, PullDetail, PullList, PullRequest, PullState, ReviewAction } from "./index.js";
export type Involvement = "involved" | "created" | "review_requested" | "assigned";
export interface ReviewAccount {
  readonly id: string; readonly host: string; readonly login: string;
  readonly source: "cli" | "environment" | "token";
}
export interface AccountCatalog { readonly accounts: readonly ReviewAccount[]; readonly notices: readonly string[] }
/** Account identity is part of the target even when several accounts can read the same PR. */
export interface RepositoryTarget { readonly accountId: string; readonly repository: string }
export interface InboxTarget extends RepositoryTarget { readonly id: number }
export interface InboxPull extends PullRequest {
  readonly repository: string; readonly host: string;
  readonly accounts: readonly string[];
}
export interface InboxQuery {
  readonly accountId?: string; readonly involvement: Involvement;
  readonly query: string; readonly state: PullState; readonly page: number;
}
export interface InboxResult {
  readonly items: readonly InboxPull[]; readonly hasMore: boolean;
  readonly notices: readonly string[];
  readonly unavailable: boolean;
}
export interface LocalReview { readonly projectId: string; readonly remote: string }
export interface InboxDetail extends PullDetail { readonly local?: LocalReview }
export interface ReviewInboxGateway {
  accounts(refresh: boolean): Promise<AccountCatalog>;
  connect(host: string, token: string): Promise<ReviewAccount>;
  list(query: InboxQuery): Promise<InboxResult>;
  repositoryList(target: RepositoryTarget, query: string, state: PullState, page: number): Promise<PullList>;
  create(target: RepositoryTarget, input: CreatePull): Promise<PullRequest>;
  local(path: string, target: InboxTarget): Promise<string | undefined>;
  detail(target: InboxTarget, local?: { path: string; remote: string }): Promise<PullDetail>;
  act(target: InboxTarget, action: ReviewAction, body: string, head: string): Promise<void>;
  sync(target: InboxTarget, path: string, remote: string): Promise<string>;
}

/**
 * The inbox does not require a checkout. Only Timeline resolves a saved local project.
 * Local matches come from Git remotes, not renderer-supplied paths or repository labels.
 */
export class ReviewInboxService {
  constructor(private readonly gateway: ReviewInboxGateway,
    private readonly projects: () => Promise<readonly { id: string; path: string }[]>) {}
  accounts(refresh = false) { return this.gateway.accounts(refresh); }
  connect(host: string, token: string) { return this.gateway.connect(host, token); }
  list(query: InboxQuery) { return this.gateway.list(query); }
  repositoryList(target: RepositoryTarget, query: string, state: PullState, page: number) { return this.gateway.repositoryList(target, query, state, page); }
  async create(target: RepositoryTarget, input: CreatePull) {
    if (!input.title.trim() || !input.source.trim() || !input.target.trim() || input.source === input.target) throw new Error("Enter a title and different source and target branches.");
    return this.gateway.create(target, input);
  }
  private async local(target: InboxTarget, projectId?: string): Promise<(LocalReview & { path: string }) | undefined> {
    // Resolve in small batches: a large saved-project collection must not spawn unbounded Git jobs.
    const projects = (await this.projects()).filter((project) => !projectId || project.id === projectId);
    for (let i = 0; i < projects.length; i += 4) {
      const matches = await Promise.all(projects.slice(i, i + 4).map(async (project) => {
        const remote = await this.gateway.local(project.path, target);
        return remote ? { projectId: project.id, path: project.path, remote } : undefined;
      }));
      const match = matches.find(Boolean); if (match) return match;
    }
    return undefined;
  }
  async detail(target: InboxTarget): Promise<InboxDetail> {
    const local = await this.local(target);
    const detail = await this.gateway.detail(target, local);
    return { ...detail, ...(local ? { local: { projectId: local.projectId, remote: local.remote } } : {}) };
  }
  act(target: InboxTarget, action: ReviewAction, body: string, head: string) { return this.gateway.act(target, action, body, head); }
  async sync(target: InboxTarget, projectId?: string): Promise<{ projectId: string; checkpointId: string }> {
    const local = await this.local(target, projectId);
    if (!local) throw new Error("Add this repository's local folder to Rack, then retry View in Timeline.");
    return { projectId: local.projectId, checkpointId: await this.gateway.sync(target, local.path, local.remote) };
  }
}
