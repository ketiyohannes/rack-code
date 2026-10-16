# Runtime integration notes

Status: documentation findings and implemented adapter notes, updated 2026-10-12. Claude subscription authentication and account-isolation documentation were rechecked on that date. The adapter code targets the locally installed Codex CLI and `@anthropic-ai/claude-agent-sdk` versions; live credential execution remains an operator verification step. Documentation can change; verify against pinned versions before packaging.

## Codex app server

Local diagnostics initialize the server without creating a thread or model
turn. Saved-account checks call `account/read` with `refreshToken: false` and
report only whether a ChatGPT account is present. Initialization, login-start
and account-read control requests now have 10-second deadlines; cancellation
has a two-second deadline. User browser interaction itself is not timed out.
The transport settles pending requests on close and drains stderr without
exposing provider output. Runtime/model/terminal initialization shares the
startup deadline; long-running work is unaffected.

### Windows executable discovery (2026-10-16)

Sign-in and runtime operations share `adapters/runtimes/codex-command.ts` to
resolve a native `codex.exe`. Electron's direct process spawning cannot run
npm's PowerShell or command-file launchers as a bare `codex` command. The
resolver checks absolute PATH entries in order for native executables and
known npm package layouts, then the standard `%APPDATA%/npm` installation
when the desktop inherited an older PATH. Both x64 and ARM64 package layouts
are supported. It launches without a shell and preserves account-specific
`CODEX_HOME` isolation. Explicit adapter command overrides and non-Windows
launches keep their existing behavior.

If no supported installation is found, the error asks the user to install
Codex CLI for Windows and restart Rack. Custom npm prefixes must be on PATH;
restart the app after changing PATH. This resolves launch failures such as
`spawn codex ENOENT`; it does not complete browser authentication for the user.

The official documentation describes threads, turns, streamed items, native resume, history reads, client approval requests, and MCP integration. It also describes experimental history injection and dynamic tools; those should not become assumed stable dependencies. Native thread state remains Codex-managed, even when our application owns the user-facing conversation. This does not document a universal transcript interchangeable with Claude.

The documentation exposes account rate-limit queries and updates. It distinguishes local/open-source app-server authentication from commercial or hosted offerings, directing the latter toward Sign in with ChatGPT. Confirm the supported authentication route for the intended distribution model before implementing subscription-account switching.

The reference inspected does not establish a reusable browser window that our UI can directly embed or launch. MCP support offers an integration boundary for app-provided tools; browser compatibility still needs validation. These findings come from the [Codex app-server reference](https://learn.chatgpt.com/docs/app-server), reached through the official developer documentation redirect.

## Claude Agent SDK sessions

The Claude sign-in connector now resolves native Windows `claude.exe` through
PATH and the standard `%USERPROFILE%/.local/bin` installation before spawning
it directly. Explicit command overrides are retained; a missing native install
produces installation/restart guidance. This does not change the SDK's own
runtime executable selection. Local diagnostics use `--version` and, for a saved
account only, `auth status --json`, each bounded to 10 seconds and 64 KiB of
captured stdout. Only normalized sign-in state and a parsed version reach the UI.

The SDK documents native session IDs, resume, and fork. Session history and workspace files are distinct: resuming or forking a conversation does not restore or isolate its filesystem. Prefer explicit native IDs over continuing whichever session happens to be most recent. See [working with sessions](https://code.claude.com/docs/en/agent-sdk/sessions).

The SDK also documents a custom SessionStore with append/load operations. It mirrors native transcript entries after local writes; it does not replace the native session format. Entries must be returned unchanged in meaning and order. This is useful for retaining native continuation data beneath an app-owned session, not converting Claude into a stateless consumer of a universal transcript.

The storage guide documents best-effort mirror writes, possible dropped batches, and an incompatibility between SessionStore and the SDK's file checkpointing option. Do not treat this mirror alone as guaranteed durable application history or assume checkpointing features compose without investigation. See [external session storage](https://code.claude.com/docs/en/agent-sdk/session-storage).

## Permissions and tools

Claude's permission evaluation can resolve tool calls before the canUseTool callback. The documentation recommends PreToolUse hooks for checks that must run on every tool call. App policy needs an explicit mapping into runtime controls; a callback alone is not a complete enforcement boundary. See [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions).

Claude documents WebSearch and WebFetch. These search or retrieve content; they do not establish access to a shared interactive browser tab. See the [tools reference](https://code.claude.com/docs/en/tools-reference).

The SDK supports externally configured MCP servers and app-defined tools. This provides a candidate route for an app-owned browser, subject to implementation and permission validation. See [SDK MCP integration](https://code.claude.com/docs/en/agent-sdk/mcp).

### Claude subscription authentication and multiple accounts

The SDK is designed to embed Claude Code's agent loop in a TypeScript or Python application. It runs the Claude Code binary and exposes built-in tools, permissions, sessions, hooks, and MCP. This fits the intended wrapper architecture. See the [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

Technical subscription support is documented explicitly:

- `CLAUDE_CODE_OAUTH_TOKEN` supplies a claude.ai OAuth token for SDK and automated environments. `claude setup-token` generates a subscription-backed token for Pro, Max, Team, or Enterprise accounts. The token is not automatically saved or refreshed; an expired environment token requires replacement and a process restart. Bare mode does not read it. See [environment variables](https://code.claude.com/docs/en/env-vars) and [generate a long-lived token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token).
- `CLAUDE_CONFIG_DIR` gives each account separate settings, native session history, plugins, and claude.ai login credentials. On macOS, the Keychain entry is keyed to this directory too; on other documented platforms, the credential file resides in that directory. Keyless Claude Console sign-ins are a separate case and are not isolated by this setting. See [multiple-account login](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts) and [credential management](https://code.claude.com/docs/en/authentication#credential-management).
- The TypeScript SDK's `options.env` replaces the spawned process environment. The adapter can therefore supply the selected account's configuration directory and authentication values per process, without changing the parent process environment. Inherited `ANTHROPIC_API_KEY` must be excluded when using subscriptions because it overrides subscription billing. See the [SDK options](https://code.claude.com/docs/en/agent-sdk/typescript#options) and [environment-variable precedence](https://code.claude.com/docs/en/env-vars).
- `query.accountInfo()` exposes fields including email, organization, subscription type, and credential sources. `SDKRateLimitEvent` carries status and optional reset/utilization information, including subscription credit exhaustion. These are observations, not a guarantee that every subscription limit can be queried in advance. See [account information](https://code.claude.com/docs/en/agent-sdk/typescript#accountinfo) and [rate-limit events](https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent).

A concrete candidate integration is one account-specific Claude Code process launched by the SDK with its own `CLAUDE_CONFIG_DIR` and a deliberately constructed `options.env`. Authentication can use the login stored in that directory or an explicitly supplied subscription OAuth token. Account switching selects a different context for the next attempt; it does not rewrite an active process's credentials. Runtime tests must still verify login, refresh or token replacement, concurrent isolation, account identity, resume across account changes, and exhaustion handling against pinned versions.

The SDK overview is explicit that the Agent SDK embeds Claude Code's agent loop in a developer's own application, and Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) state that Services may power products made available to a customer's own users. The project therefore proceeds with a Claude Agent SDK wrapper using users' own subscriptions. The implementation must preserve the documented account and credential boundaries and keep the source terms linked for distribution review; it does not treat Claude subscription support as a technical blocker or replace the product requirement with API-key-only access.

## Proposed application boundary

Own the logical session, user-visible history, execution records, selected permission mode, and runtime associations. Preserve native continuation state behind each adapter and use supported runtime mechanisms to resume it. On a runtime handoff, supply relevant application context not already seen by the target runtime. This is a proposed design based on the documentation, not a claim that lossless cross-runtime resume is already provided.

The MVP now creates one Codex app-server process per attempt with an account-specific `CODEX_HOME`, and one Claude SDK query with an account-specific `CLAUDE_CONFIG_DIR` and merged child-process environment. It maps native message, tool, approval, usage, rate-limit, completion, interruption, and failure signals into the core event contract. Browser and computer-use capabilities are explicitly reported as unsupported by these adapters until a supported app-owned integration is implemented. Pi integration remains unresearched.

## Implemented sign-in

Status: implemented 2026-10-12 against Codex CLI 0.162.1 and Claude Code 2.1.296.

- **Codex.** `CodexConnector` starts `codex app-server --stdio` with the account's `CODEX_HOME` and calls `account/login/start` with `{ "type": "chatgpt" }`. That returns `authUrl` and `loginId`, and the client opens `authUrl`. It then waits for `account/login/completed` and reads `account/read` (email and `planType`). Codex stores the login in `CODEX_HOME`. The protocol was confirmed with `codex app-server generate-json-schema`, and a live probe returned an `auth.openai.com` sign-in URL and cancelled cleanly. A full sign-in was not performed.
- **Claude.** `ClaudeConnector` runs `claude auth login --claudeai` with the account's `CLAUDE_CONFIG_DIR` and API-key variables removed. The CLI opens the browser itself, and any printed URL is offered as a fallback. If the CLI asks for a pasted code, the UI sends it to stdin. On success, `claude auth status --json` (same directory) supplies the identity. `claude auth status --json` against an empty isolated directory returned `loggedIn: false`, confirming per-directory status. A full sign-in was not performed.

## Thinking and tool presentation

Updated 2026-10-14. Codex maps `item/reasoning/summaryTextDelta` and `item/reasoning/textDelta` into separately identified summary/trace streams. Final reasoning items supply missing readable text without duplicating streamed prefixes; opaque reasoning is not decoded. Raw reasoning text is available only when exposed by the selected model, as documented in the [app-server event reference](https://learn.chatgpt.com/docs/app-server).

Claude requests `includePartialMessages` and maps readable thinking deltas and final assistant blocks without duplicating text already streamed. Redacted thinking and signature blocks are not decoded. Both adapters preserve tool call IDs. Codex output chunks become output-delta events, and final tool items carry authoritative output/outcomes; agent-message or reasoning completion is not misclassified as a tool result. Claude streaming tool arguments update one call, and tool results use their native `tool_use_id`.

Session readers also retain plaintext thinking returned by their public history APIs. Imported Claude tool calls and results are joined by native call ID before persistence; pending calls are not labelled successful. The complete original provider context is still not transferred across account stores.
