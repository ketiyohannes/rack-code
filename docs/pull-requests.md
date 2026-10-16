# Pull requests and Usage

Implemented on `feature/pr-support` (2026-10-16).

The sidebar footer contains icon-only Settings, Usage and Pull Requests buttons, each with a tooltip and accessible name. Notices appear at the bottom left above this footer. Usage and Pull Requests occupy the main area; closing either returns to the selected conversation. Hidden workbench panels pause polling and the shared browser view is hidden.

## Account-wide GitHub inbox

Pull Requests opens a unified inbox across every connected GitHub identity, including multiple logins on the same host and GitHub Enterprise accounts. No saved project or local checkout is required. The compact list shows repository, PR number, author, account and update time; selecting a row opens a focused review with Overview, Code and Activity tabs. This layout follows the involvement filters and compact list in [T3's PR route](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/routes/_chat.pull-requests.tsx).

All my PRs combines authored, assigned, mentioned/commented-on, requested reviews (including teams), and previously reviewed PRs across repositories. Created, Review requested and Assigned narrow that scope. The account selector defaults to All accounts; status and plain-text search apply to each identity. This personal inbox does not mean every public PR on GitHub or every unrelated PR in an accessible repository. Repositories retains repository-wide browsing for those reviews, along with GitLab and Bitbucket Cloud.

Overlapping PRs are deduplicated by host/repository/number and retain their account choices. Review as explicitly selects the identity used for detail, checks, discussion and every mutation. Changing identity retains separate comment drafts and review decisions. Unavailable credentials never fall back to another login. Partial account failures leave successful results visible with a warning; all-account failure has an unavailable state rather than an empty-success message. Search and detail generations reject stale results after navigation or identity changes, and background refresh preserves focused review input.

Load more reads the next 50 entries per account/search lane and merges them by update time, including duplicates crossing page boundaries. All my PRs uses separate involvement, review-requested and reviewed-by searches because GitHub's involvement qualifier excludes review requests, and pending requests disappear after review. These follow [GitHub's search qualifiers](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests). GitHub limits each search to 1,000 results; the inbox discloses that window and incomplete results. Narrow status/search to reach older results. The first page refreshes every 30 seconds while visible; loading older pages pauses automatic refresh until an explicit refresh starts again at page one.

## Repository workflows

Repositories selects a saved project and its code-host remote. New PR opens creation for the current project, or asks for a repository folder when none exists. GitHub repository browsing and creation offer an explicit account choice; creation can choose its identity inside the form. Other provider workflows retain their existing connections. Rack discovers GitHub, GitLab and Bitbucket Cloud HTTPS/SSH remotes from Git, including nested GitLab groups. It provides:

- Debounced search, open/merged/closed/all filters, pagination, explicit refresh and a 30-second refresh while visible.
- A tabbed review with description, changed files, file filtering, collapsible patches, line numbers, discussion, reviews, inline GitHub review annotations and available CI checks. Provider text is rendered as text, never injected HTML.
- Summary comments, approval, request changes where supported, merge, close and reopen where supported. Merge/close/reopen require confirmation in the app. Reviews recheck the head commit; GitHub/GitLab merge requests include the reviewed SHA. Code-host protection rules remain authoritative.
- Creation with title, description, source/target branch and draft status. Publishing a local source branch is a separate explicit normal push with no force. It pushes committed changes only and is blocked while an app-managed run owns the project writer lock. Creation never commits files or silently publishes a branch.
- An external code-host link for controls outside Rack and for large reviews.

GitHub and Bitbucket support request-changes reviews. GitLab's version-dependent blocking review behavior is not represented as a portable action; use comments or the GitLab link. Bitbucket Cloud cannot reopen declined PRs through the implemented API. GitLab is presented under the shared Pull Requests name and uses merge-request APIs. Bitbucket Data Center has a different API and is not supported.

Provider list pages contain up to 50 entries. GitHub search has its 1,000-result window. Discussion/check reads are bounded to 100 entries per endpoint; shortened results are labelled. Responses above 2 MB are rejected with a code-host fallback; the UI renders at most 200 files and 5,000 diff lines. Summary review submission is supported; authoring inline line comments, assigning reviewers, local branch checkout, staging/committing and conflict resolution are outside this implementation.

## Connections

GitHub discovers every account in `gh auth status --json hosts`, without `--active`. Stored credentials are read with `gh auth token --hostname <host> --user <login>`; Rack never runs `gh auth switch`. Environmental token overrides are removed only from those credential lookup subprocesses so they cannot impersonate every stored login. `GH_TOKEN`/`GITHUB_TOKEN` supplies a separate github.com identity; `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` is used only with an explicit non-cloud `GH_HOST`. Matching host/login identities are deduplicated, preferring an explicit Rack token, then environment, then CLI credentials. The catalog caches for 30 seconds; Refresh rescans. The installed gh must support the per-user token option; otherwise connect that identity with a token.

Accounts lets you inspect discovered identities, refresh after `gh auth login`, or connect another GitHub identity with a token and hostname. GitHub verifies `/user` before adding/replacing that exact identity. Tokens remain only in host memory until exit, never in project, session, analytics, AI account records or renderer responses. API operations snapshot one selected credential for their entire request sequence. Reusable credentials stay in the CLI's login store; this feature adds no persistent vault or OAuth enrollment.

GitLab uses the active `glab auth` login, `GITLAB_TOKEN` or `GL_TOKEN`. Bitbucket Cloud accepts a bearer access token through `BITBUCKET_TOKEN` or its repository Connection dialog (OAuth/repository/workspace access tokens, not an email/API-token basic-auth pair). Those providers retain host-scoped session connections. Their dialog validates repository access before replacing a working token. Public repository reads work when the provider permits them; private reads and mutations require authentication.

The GitHub inbox recognizes hosts already connected through gh or explicitly entered in Accounts. To discover local GitHub Enterprise or self-managed GitLab remotes, map those hosts before launch:

```sh
RACK_CODE_HOSTS=github.example.org=github,git.example.org=gitlab npm start
```

Cloud environment tokens are never forwarded to enterprise hosts. Use a matching host login or host-specific token. API calls use HTTPS, bounded reads, timeouts and same-origin redirects. Git fetch/push uses the user's Git/SSH credential configuration separately from API authentication. A successful API connection does not automatically configure Git transport credentials.

## Timeline synchronization

View in Timeline fetches the PR head and the provider's base commit into `refs/rack-pr-objects/`. It compares their merge base to the complete PR head tree, creates an immutable comparison under `refs/rack-pr-timeline/`, and opens the existing snapshot viewer. The comparison includes all PR commits, rather than only the final commit's patch. HEAD, local branches, index, working files and FETCH_HEAD are left untouched. Ordinary Git network credentials must permit fetch access.

The project Timeline includes these comparisons alongside Git history and recorded observations, without requiring session recording. Its Pull Requests shortcut opens the account inbox and retains that project's identity for Repositories/New PR, including a repository opened from a nested folder. Inbox reviews resolve a local project by exact host/repository remote identity; if none exists, View in Timeline asks for a local folder and validates its remote before syncing. Ordinary review access still requires no checkout. On subsequent PR-detail refreshes, previously synced head/base changes refresh the comparison automatically. A failed sync is visible in the PR detail and can be retried. Remote refresh happens while the PR workspace is visible; Rack does not continuously poll every code host in the background.

Comparison refs survive restart. Earlier versions remain reachable for open viewers, subject to Timeline's existing bounded history window. These are local review observations, never remote branch commits and never pushed by the publish operation.

## Usage

Usage reads the execution service's audit projection across saved runs, including runs whose conversations were removed. Filter by project and the last 7, 30, 90 or 365 UTC days. The page shows run outcomes, reported input/output tokens and cost, daily run activity, and model/provider totals; it refreshes while visible.

Repeated cumulative usage notifications are replaced per field per attempt, then attempts are added together. Codex nested thread totals are normalized to the active attempt; on resumed threads the initial total minus the latest increment establishes the earlier-turn baseline. Updates for other native turns are ignored. Missing token/cost observations stay unavailable, with coverage counts; costs are provider-reported observations, not subscription bills or inferred pricing. Runs are assigned to the UTC date they started. Imported conversations have no usage until Rack records a run. The projection omits prompts, attachments, messages and tool output.

## Implementation boundaries

`features/pull-requests` owns the public project and inbox contracts, project validation and saved-project resolution for Timeline. `ReviewInboxService` consumes a narrow project-list port and never accepts renderer filesystem paths. `adapters/code-hosts` owns provider REST mappings, credential lookup, remote parsing and bounded Git operations. `features/usage` aggregates a narrow public execution audit projection. Startup composition assembles these services explicitly; core execution does not depend on either feature or on Electron. The typed desktop commands validate requests in main and in the host. Pages share a tabbed detail renderer and own query generations plus drafts keyed by account/repository/PR; late replies cannot replace another account or project's results.

## Validation

Provider contract fixtures cover GitHub, GitLab and Bitbucket list/detail/create/review/merge mappings, search scope, head-change rejection, error redaction, redirect restrictions and response bounds. Temporary Git integration covers full-PR Timeline comparisons, no duplicate unchanged sync, retained previous versions, and preserving HEAD/index/staged/unstaged edits. Usage tests cover cumulative snapshots, attempt totals, missing data, project/date filtering and excluding private content.

The earlier PR implementation passed 216 tests and native Electron checks for footer destinations, empty pages and the offline toast. Account-inbox validation adds fixtures for all CLI users/hosts, environment isolation, identity deduplication, selected inactive-account reads/reviews/creation, no credential fallback, partial/total account failures, repository identity validation, search windows and exact local project targeting. Current complete-check and renderer results are recorded in [changes.md](changes.md).

A read-only discovery check found zero connected GitHub accounts in this environment; live authenticated account aggregation could not be exercised.

Live authenticated provider mutations, enterprise deployments and a packaged distribution are not exercised by these fixtures.
