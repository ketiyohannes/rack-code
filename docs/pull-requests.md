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

**Review surface (2026-10-19).** PR descriptions and Activity bodies render as Markdown through the app's text-node renderer (no HTML injection; links open in the default browser; template HTML comments are hidden). Long descriptions start collapsed behind Show full description. The header shows a state badge (icon plus Open, Draft, Merged or Closed), the source and target branches, and icon actions for Timeline, refresh and the code host. Tabs carry icons and file/comment counts. Checks normalize provider vocabularies to Passed, Failed, In progress or Skipped, each an icon plus a word, with a summary count. Activity distinguishes conversation comments, submitted reviews (approved, changes requested, commented, dismissed) and inline comments with their `path:line`. GitHub reviews that only group inline comments, and unsubmitted pending reviews, are omitted. GitLab system notes are omitted. Merge, Close/Reopen and Submit review are icon-plus-label buttons. Status colors reuse the Changes diff tokens, so every palette and light/dark mode applies. The repository page shares the inbox's heading and row design. Its New pull request dialog has labeled fields, a From → Into branch pair defaulting the target to the remote's `main`, `master` or `develop`, a labeled draft toggle, and progress messages separate from errors.

**Large PRs.** GitHub file changes come from the per-file API (`/pulls/{id}/files`, 30 per page, up to 300 files) instead of one raw diff. A PR with generated or vendored files therefore stays reviewable: GitHub omits those patches but still reports each file and its counts, and the Code tab labels them as too large to show. GitLab uses its per-file `/diffs` reply in the same shape. Bitbucket still reads a raw diff; one over the 2 MB response limit is cut to whole files and marked shortened instead of failing the review. GitHub's HTTP 406 "diff too large" reply is handled the same way. Previously, any raw diff over 2 MB made the entire PR fail to open.

Provider list pages contain up to 50 entries. GitHub search has its 1,000-result window. Discussion/check reads are bounded to 100 entries per endpoint; shortened results are labelled. Responses above 2 MB are rejected with a code-host fallback; the UI renders at most 200 files and 5,000 diff lines. Summary review submission is supported; authoring inline line comments, assigning reviewers, local branch checkout, staging/committing and conflict resolution are outside this implementation.

## Connections

GitHub discovers every account in `gh auth status --json hosts`, without `--active`. Each entry's `login` field is the username; the older `account` field is also accepted. Earlier builds read only `account`, so they found no gh logins. Stored credentials are read with `gh auth token --hostname <host> --user <login>`; Rack never runs `gh auth switch`. Environmental token overrides are removed only from gh subprocesses so they cannot impersonate every stored login, and because `gh auth login` refuses to run while `GH_TOKEN` is set. `GH_TOKEN`/`GITHUB_TOKEN` supplies a separate github.com identity; `GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` is used only with an explicit non-cloud `GH_HOST`. Matching host/login identities are deduplicated, preferring environment over CLI credentials. The catalog caches for 30 seconds; Refresh rescans. Each account's inbox search is retried once after a second before it is reported unavailable, which absorbs transient keychain or secondary-rate-limit failures.

**Browser sign-in.** Rack never asks for a GitHub token. GitHub accounts (the GitHub logo in the inbox header, Sign in with GitHub in the empty inbox, or the repository connection button for GitHub remotes) opens a dialog that lists signed-in identities and offers **Continue with browser**. The host runs `gh auth login --web --hostname <host>` without a TTY, so gh prints a one-time device code and verification URL instead of prompting. Rack accepts the URL only if it is `https` on the requested host. The dialog shows the code, copies it to the clipboard and opens the page in the default browser. gh polls GitHub until the user authorizes, then stores the credential in its keychain-backed store. Rack rescans gh logins and selects the identity gh reported. The account stays connected after restart because it is an ordinary gh login. Closing the dialog or pressing Cancel stops gh; a sign-in is stopped after 15 minutes (the device-code lifetime) or when the host shuts down. Rack only surfaces a short final gh output line, with token-like strings redacted. GitHub Enterprise hosts can be entered in the inbox dialog. Browser sign-in requires the GitHub CLI (`gh`); without it, the dialog says to install it from https://cli.github.com. gh requests its default `repo`, `read:org` and `gist` scopes.

Tokens are never sent to the renderer. API operations snapshot one selected credential for their entire request sequence.

GitLab uses the active `glab auth` login, `GITLAB_TOKEN` or `GL_TOKEN`. Bitbucket Cloud accepts a bearer access token through `BITBUCKET_TOKEN` or its repository Connection dialog (GitLab and Bitbucket keep this token dialog; only GitHub moved to browser sign-in) (OAuth/repository/workspace access tokens, not an email/API-token basic-auth pair). Those providers retain host-scoped session connections. Their dialog validates repository access before replacing a working token. Public repository reads work when the provider permits them; private reads and mutations require authentication.

The GitHub inbox recognizes hosts already connected through gh, including those signed in from the GitHub accounts dialog. To discover local GitHub Enterprise or self-managed GitLab remotes, map those hosts before launch:

```sh
RACK_CODE_HOSTS=github.example.org=github,git.example.org=gitlab npm start
```

Cloud environment tokens are never forwarded to enterprise hosts. Use a matching host login or host-specific token. API calls use HTTPS, bounded reads, timeouts and same-origin redirects. Git fetch/push uses the user's Git/SSH credential configuration separately from API authentication. A successful API connection does not automatically configure Git transport credentials.

## Explain with AI, side chat and Open in Timeline (2026-10-19)

The review header has **Explain with AI** and **Open in Timeline** as labeled buttons, and a side-chat toggle icon. Explain with AI docks a read-only side chat beside the review and asks the selected model to explain the PR. Follow-up questions continue in the same panel. See [Side chat](side-chat.md) for context, storage and limits. Open in Timeline is the existing full-PR comparison (below), now a visible primary action.

Fixed: Open in Timeline failed with "Git fetch failed" when the review used a GitHub account other than gh's active one. For example, a private repository visible only to an inactive login. Git used the global credential helper, which authenticates as the active gh account. Fetches now authenticate as the review's account; see Timeline synchronization.

## Timeline synchronization

Fetches for the comparison authenticate HTTPS remotes with the credential of the account or connection used for the review. The header is scoped to the code host and passed through Git's environment configuration, never argv or a config file. SSH remotes keep using the user's SSH keys.


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

The earlier zero-account discovery result was caused by the `login` field bug described in Connections. After the fix, live discovery found both gh logins on this machine, and the inbox aggregated their open PRs.

Live authenticated provider mutations, enterprise deployments and a packaged distribution are not exercised by these fixtures.
