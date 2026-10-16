/** GitHub identities from every gh login, environment credentials and session-only tokens. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AccountCatalog, ReviewAccount } from "../../features/pull-requests/index.js";
import { RestCodeHosts } from "./rest.js";
import { parseRemote, type Remote } from "./repository.js";
const exec = promisify(execFile);
export type GitHubCli = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
const runCli: GitHubCli = async (args, env) => (await exec("gh", [...args], { env, timeout: 5000, maxBuffer: 1_000_000 })).stdout;
const identity = (host: string, login: string) => `github:${host.toLowerCase()}:${login.toLowerCase()}`;
/** Both the host and slug are validated before they can become an authenticated API URL. */
export function githubRemote(host: string, repository: string, name = "inbox"): Remote {
  if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(host) || host.includes("..")) throw new Error("Enter a GitHub hostname, without a URL or path.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/").some((part) => part === "." || part === "..")) throw new Error("Choose a valid GitHub repository (owner/name).");
  const remote = parseRemote(name, `https://${host}/${repository}`, `${host.toLowerCase()}=github`);
  if (!remote || remote.provider !== "github") throw new Error("Choose a valid GitHub repository (owner/name).");
  return remote;
}
export class GitHubAccounts {
  private entries = new Map<string, { view: ReviewAccount; token?: string }>();
  private manual = new Map<string, { view: ReviewAccount; token: string }>();
  private cached: { at: number; result: AccountCatalog } | undefined;
  private pending: Promise<AccountCatalog> | undefined;
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly cli: GitHubCli = runCli,
    private readonly environment: NodeJS.ProcessEnv = process.env) {}
  private cliEnvironment(): NodeJS.ProcessEnv {
    const env = { ...this.environment };
    // gh gives env tokens precedence over --user. Remove them when reading stored logins,
    // otherwise every account on a host silently executes as the same environmental user.
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete env[key];
    return env;
  }
  async accounts(refresh = false): Promise<AccountCatalog> {
    if (!refresh && this.cached && Date.now() - this.cached.at < 30_000) return this.cached.result;
    if (this.pending) return this.pending;
    this.pending = this.discover();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async discover(): Promise<AccountCatalog> {
    const entries = new Map<string, { view: ReviewAccount; token?: string }>();
    const notices: string[] = [];
    try {
      const data = JSON.parse(await this.cli(["auth", "status", "--json", "hosts"], this.cliEnvironment()));
      for (const [host, logins] of Object.entries(data.hosts ?? {})) {
        if (!Array.isArray(logins)) continue;
        for (const login of logins) {
          if (typeof login.account !== "string" || !/^[\w-]+$/.test(login.account)) continue;
          try { githubRemote(host, "owner/repo"); } catch { continue; }
          const view: ReviewAccount = { id: identity(host, login.account), host: host.toLowerCase(), login: login.account, source: "cli" };
          entries.set(view.id, { view });
        }
      }
    } catch { notices.push("GitHub CLI logins could not be read. Connect with a token below, or install/sign in with gh."); }
    const envTokens: { host: string; token: string }[] = [];
    const cloud = this.environment.GH_TOKEN ?? this.environment.GITHUB_TOKEN;
    if (cloud) envTokens.push({ host: "github.com", token: cloud });
    const enterprise = this.environment.GH_ENTERPRISE_TOKEN ?? this.environment.GITHUB_ENTERPRISE_TOKEN;
    if (enterprise && this.environment.GH_HOST && this.environment.GH_HOST !== "github.com") envTokens.push({ host: this.environment.GH_HOST, token: enterprise });
    for (const entry of envTokens) {
      try {
        const view = await this.identify(entry.host, entry.token, "environment");
        entries.set(view.id, { view, token: entry.token });
      } catch { notices.push(`An environment GitHub credential could not be verified for ${entry.host}. Other accounts remain available.`); }
    }
    // Explicit Rack connections override credentials for the same identity, never other accounts.
    for (const [id, entry] of this.manual) entries.set(id, entry);
    this.entries = entries;
    const result = { accounts: [...entries.values()].map((entry) => entry.view).sort((a, b) => `${a.host}/${a.login}`.localeCompare(`${b.host}/${b.login}`)), notices };
    this.cached = { at: Date.now(), result };
    return result;
  }
  private async identify(host: string, token: string, source: ReviewAccount["source"]): Promise<ReviewAccount> {
    const remote = githubRemote(host, "owner/repo");
    const client = new RestCodeHosts(this.fetcher, async () => token);
    const user = await client.request(remote, "/user");
    if (typeof user.login !== "string" || !/^[\w-]+$/.test(user.login)) throw new Error("GitHub did not return an account identity.");
    return { id: identity(remote.host, user.login), host: remote.host, login: user.login, source };
  }
  async connect(host: string, token: string): Promise<ReviewAccount> {
    if (!token.trim()) throw new Error("Enter a GitHub access token.");
    const view = await this.identify(host.trim().toLowerCase(), token.trim(), "token");
    if (this.pending) await this.pending;
    this.manual.set(view.id, { view, token: token.trim() });
    this.cached = undefined;
    await this.accounts(true);
    return view;
  }
  async account(id: string): Promise<ReviewAccount> {
    await this.accounts();
    const account = this.entries.get(id)?.view;
    if (!account) throw new Error("This GitHub account is no longer connected. Refresh accounts and select one again.");
    return account;
  }
  async token(id: string): Promise<string> {
    const view = await this.account(id), entry = this.entries.get(id)!;
    if (entry.token) return entry.token;
    try {
      const token = (await this.cli(["auth", "token", "--hostname", view.host, "--user", view.login], this.cliEnvironment())).trim();
      if (token) return token;
    } catch { /* CLI stderr may contain credentials; report only the selected identity. */ }
    throw new Error(`Reconnect ${view.login} on ${view.host}; its GitHub credential is unavailable.`);
  }
}
