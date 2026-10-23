/** Provider-neutral code review capability. Credentials and Git live in adapters. */
export type CodeHost = "github" | "gitlab" | "bitbucket";
export type PullState = "open" | "closed" | "merged" | "all";
export type ReviewAction = "comment" | "approve" | "request_changes" | "merge" | "close" | "reopen";
export interface ReviewRepository {
  readonly remote: string;
  readonly host: string;
  readonly provider: CodeHost;
  readonly slug: string;
  readonly branch: string;
  readonly branches: readonly string[];
  readonly authenticated: boolean;
}
export interface PullRequest {
  readonly id: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: string;
  readonly state: Exclude<PullState, "all">;
  readonly draft: boolean;
  readonly sourceRepository?: string;
  readonly source: string;
  readonly target: string;
  readonly head: string;
  readonly base: string;
  readonly updatedAt: string;
}
/**
 * One Activity entry. `kind` separates conversation comments, submitted reviews
 * (with their decision in `state`) and inline code comments (with `path`/`line`).
 * `body` is the author's Markdown, never annotated by Rack.
 */
export interface ReviewComment {
  readonly author: string; readonly body: string; readonly createdAt: string;
  readonly kind?: "comment" | "review" | "inline";
  readonly state?: "approved" | "changes_requested" | "commented" | "dismissed";
  readonly path?: string; readonly line?: number;
}
/**
 * A changed file as reported by the code host. `patch` holds unified-diff
 * hunks and is absent when the host omits it (binary or oversized files);
 * `additions`/`deletions` are the host's counts either way.
 */
export interface ReviewFile {
  readonly path: string; readonly previousPath?: string;
  readonly status: "added" | "modified" | "removed" | "renamed";
  readonly additions: number; readonly deletions: number;
  readonly patch?: string;
}
export interface ReviewCheck { readonly name: string; readonly status: string; readonly url: string }
export interface PullDetail {
  readonly checks: readonly ReviewCheck[];
  readonly checksNotice?: string;
  readonly pull: PullRequest;
  /** Unified diff text; empty when `files` carries the changes instead. */
  readonly diff: string;
  /** Per-file changes (GitHub, GitLab). Preferred over `diff` when present. */
  readonly files?: readonly ReviewFile[];
  readonly comments: readonly ReviewComment[];
  readonly truncated: boolean;
  readonly timelineCheckpointId?: string;
  readonly timelineError?: string;
}
export interface PullList { readonly items: readonly PullRequest[]; readonly hasMore: boolean }
export interface CreatePull { readonly title: string; readonly body: string; readonly source: string; readonly target: string; readonly draft: boolean }
export interface PullRequestGateway {
  repositories(path: string): Promise<readonly ReviewRepository[]>;
  connect(path: string, remote: string, token: string): Promise<void>;
  list(path: string, remote: string, query: string, state: PullState, page: number): Promise<PullList>;
  detail(path: string, remote: string, id: number): Promise<PullDetail>;
  create(path: string, remote: string, input: CreatePull): Promise<PullRequest>;
  act(path: string, remote: string, id: number, action: ReviewAction, body: string, head: string): Promise<void>;
  publish(path: string, remote: string, branch: string): Promise<void>;
  /** Fetches immutable review trees into a hidden namespace and returns a Timeline ID. */
  sync(path: string, remote: string, id: number): Promise<string>;
}

/** Resolves saved project identities on every request; never accepts renderer paths. */
export class PullRequestsService {
  /** Composition supplies live ownership; persisted legacy locks are not authoritative. */
  constructor(private readonly project: (id: string) => Promise<{ path: string; busy: boolean }>, private readonly gateway: PullRequestGateway) {}
  private async path(id: string, mutation = false): Promise<string> {
    const project = await this.project(id);
    if (mutation && project.busy) throw new Error("Wait for the project's active runs before publishing a branch.");
    return project.path;
  }
  async repositories(id: string) { return this.gateway.repositories(await this.path(id)); }
  async connect(id: string, remote: string, token: string) { await this.gateway.connect(await this.path(id), remote, token); }
  async list(id: string, remote: string, query: string, state: PullState, page: number) { return this.gateway.list(await this.path(id), remote, query, state, page); }
  async detail(id: string, remote: string, number: number) { return this.gateway.detail(await this.path(id), remote, number); }
  async create(id: string, remote: string, input: CreatePull) {
    if (!input.title.trim() || !input.source.trim() || !input.target.trim() || input.source === input.target) throw new Error("Enter a title and different source and target branches.");
    return this.gateway.create(await this.path(id), remote, input);
  }
  async act(id: string, remote: string, number: number, action: ReviewAction, body: string, head: string) { await this.gateway.act(await this.path(id), remote, number, action, body, head); }
  async publish(id: string, remote: string, branch: string) { await this.gateway.publish(await this.path(id, true), remote, branch); }
  async sync(id: string, remote: string, number: number) { return this.gateway.sync(await this.path(id), remote, number); }
}

/** Account-wide inbox is an additive public capability; project-scoped callers remain supported. */
export * from "./inbox.js";
