/**
 * Formatter registry: how a tool call reads in a tool group.
 *
 * A formatter turns a call (name, arguments, result) into an icon, a label
 * in three tenses ("Search issues" for an approval, "Searching issues" while
 * running, "Searched issues" when done), a short result summary ("4 results")
 * and, for approvals, the action and its consequence.
 *
 * Icons are as specific as the call allows: an MCP server's brand mark, the
 * program a shell command runs (git, npm, docker...), or the type of the
 * file a read or edit touches (TypeScript, Python, Markdown...); generic
 * filled icons otherwise.
 *
 * Resolution order, first defined answer wins for each aspect:
 * 1. a formatter registered for the exact MCP tool (`github/search_issues`);
 * 2. the formatter registered for its MCP server (icon, defaults);
 * 3. a built-in kind recognized from the call's shape (command, file read,
 *    file edit, search, web fetch, plan, subagent);
 * 4. generic fallbacks: MCP tool names are read as verb + object
 *    ("search_issues" -> "Searching issues"), and any other tool reads
 *    "Running <tool>: <first argument>" / "Ran <tool>: <first argument>".
 *
 * Every backend therefore works without registration. Formatters only read
 * provider-neutral data: the MCP identity normalized by the runtime adapters,
 * and common argument/result field shapes. They never check which provider
 * produced a call, and their output is display text only.
 */
import type { IconName } from "../icons.js";
import type { ToolCall, ToolGroupEntry } from "./turn-activity.js";
import { formatValue } from "./tool-presentation.js";

/**
 * "imperative" for approvals ("Query pending migrations"), "present" while
 * running, "past" once done. The failed form ("Could not query pending
 * migrations") is derived from the imperative by the registry, so formatters
 * only ever write these three.
 */
export type Tense = "imperative" | "present" | "past";
/** Every form a resolved label can take. */
export type LabelForm = Tense | "failed";

/** What a formatter can read about one call. */
export interface ToolCallContext {
  /** MCP tool name, or the provider's native tool name. Lower-cased for matching via `key`. */
  readonly name: string;
  /** MCP server name, when the call is an MCP call. */
  readonly server?: string;
  /** Arguments as an object (empty when the arguments are not an object). */
  readonly args: Readonly<Record<string, unknown>>;
  /** The provider's native input, for shape checks on non-MCP tools. */
  readonly input: unknown;
  /** Raw result, when one was reported. */
  readonly output?: unknown;
  /** Best structured reading of the result (parsed JSON content for MCP). */
  readonly payload?: unknown;
  /** Result text, when the result is textual. */
  readonly text?: string;
  readonly isError: boolean;
  /** Provider-supplied explanation attached to an approval request. */
  readonly reason?: string;
}

export interface ApprovalCopy {
  /** What will happen, imperative: "Post a message to #release". */
  readonly action: string;
  /** One-line consequence: "Sends as Arc agent to everyone in #release". */
  readonly consequence?: string;
}

export interface ToolFormatter {
  /** A fixed icon, or one chosen from the call (for example by program or file type). */
  readonly icon?: IconName | ((call: ToolCallContext) => IconName | undefined);
  label?(call: ToolCallContext, tense: Tense): string | undefined;
  summary?(call: ToolCallContext): string | undefined;
  approval?(call: ToolCallContext): ApprovalCopy | undefined;
}

export interface ResolvedFormat {
  readonly icon: IconName;
  label(form: LabelForm): string;
  readonly summary?: string;
  readonly approval: ApprovalCopy;
}

/** Built-in kinds recognized from the shape of a non-MCP call. */
export type BuiltinKind = "command" | "read" | "edit" | "search" | "web" | "plan" | "subagent" | "permissions";

export class ToolFormatterRegistry {
  private readonly tools = new Map<string, ToolFormatter>();
  private readonly servers = new Map<string, ToolFormatter>();
  private readonly builtins = new Map<BuiltinKind, ToolFormatter>();

  /** Registers a formatter for one MCP tool, under one or more tool names. */
  registerTool(server: string, tools: string | readonly string[], formatter: ToolFormatter): this {
    for (const tool of typeof tools === "string" ? [tools] : tools) this.tools.set(`${normalizeServer(server)}/${normalizeName(tool)}`, formatter);
    return this;
  }

  /** Registers defaults (usually just the icon) for every tool of an MCP server. */
  registerServer(servers: string | readonly string[], formatter: ToolFormatter): this {
    for (const server of typeof servers === "string" ? [servers] : servers) this.servers.set(normalizeServer(server), formatter);
    return this;
  }

  registerBuiltin(kind: BuiltinKind, formatter: ToolFormatter): this {
    this.builtins.set(kind, formatter);
    return this;
  }

  /** Resolves every aspect of a call's presentation; never fails. */
  resolve(call: ToolCallContext): ResolvedFormat {
    const chain: ToolFormatter[] = [];
    if (call.server !== undefined) {
      const server = normalizeServer(call.server);
      const name = normalizeName(call.name);
      const exact = this.tools.get(`${server}/${name}`) ?? this.tools.get(`${server}/${stripServerPrefix(name, server)}`);
      if (exact !== undefined) chain.push(exact);
      const defaults = this.servers.get(server);
      if (defaults !== undefined) chain.push(defaults);
      chain.push(GENERIC_MCP);
    } else {
      const kind = builtinKind(call);
      const builtin = kind === undefined ? undefined : this.builtins.get(kind);
      if (builtin !== undefined) chain.push(builtin);
      chain.push(GENERIC_TOOL);
    }
    const first = <T>(pick: (formatter: ToolFormatter) => T | undefined): T | undefined => {
      for (const formatter of chain) {
        const value = pick(formatter);
        if (value !== undefined) return value;
      }
      return undefined;
    };
    const own = (tense: Tense) => first((formatter) => nonEmpty(formatter.label?.(call, tense))) ?? humanize(call.name);
    const label = (form: LabelForm): string => form === "failed" ? `Could not ${lowerFirst(own("imperative"))}` : own(form);
    const summary = call.isError ? errorSummary(call) : first((formatter) => nonEmpty(formatter.summary?.(call)));
    const approval = first((formatter) => formatter.approval?.(call)) ?? { action: label("imperative") };
    return {
      icon: first((formatter) => typeof formatter.icon === "function" ? formatter.icon(call) : formatter.icon) ?? "wrench-fill",
      label,
      ...(summary === undefined ? {} : { summary }),
      // A reason the provider gives explains this specific request, so it
      // replaces the consequence derived from the arguments.
      approval: call.reason !== undefined ? { ...approval, consequence: call.reason } : approval,
    };
  }
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

/** Builds the formatter context from a call's identity, input and result. */
export function toolCallContext(call: {
  readonly tool: string;
  readonly input: unknown;
  readonly mcp?: { readonly server: string; readonly tool: string; readonly arguments?: unknown };
  readonly output?: unknown;
  readonly progress?: string;
  readonly isError: boolean;
  readonly reason?: string;
}): ToolCallContext {
  const rawArgs = call.mcp !== undefined ? call.mcp.arguments ?? call.input : call.input;
  const outer = record(rawArgs);
  // Some providers nest the real arguments under `input` (for example an
  // approval payload); prefer the inner object when present.
  const args = call.mcp === undefined && typeof outer.input === "object" && outer.input !== null && !Array.isArray(outer.input) ? record(outer.input) : outer;
  const { payload, text } = readResult(call.output, call.progress);
  return {
    name: call.mcp?.tool ?? call.tool,
    ...(call.mcp === undefined ? {} : { server: call.mcp.server }),
    args, input: call.input,
    ...(call.output === undefined ? {} : { output: call.output }),
    ...(payload === undefined ? {} : { payload }),
    ...(text === undefined ? {} : { text }),
    isError: call.isError,
    ...(call.reason === undefined ? {} : { reason: call.reason }),
  };
}

/**
 * Reads a result into structured data and text. MCP results arrive as
 * `structuredContent`, or as content blocks whose text is often JSON (both
 * directly and nested under `result` in some native item shapes).
 */
export function readResult(output: unknown, progress?: string): { readonly payload?: unknown; readonly text?: string } {
  if (output === undefined) return progress === undefined || progress === "" ? {} : { text: progress };
  if (typeof output === "string") return { payload: parseJson(output) ?? output, text: output };
  const outer = record(output);
  const result = record(outer.result);
  const structured = outer.structuredContent ?? result.structuredContent;
  const content = Array.isArray(output) ? output : outer.content ?? result.content;
  const blocks = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
  const text = blocks.map((block) => typeof block === "string" ? block : stringOf(record(block).text) ?? "").filter((part) => part !== "").join("\n")
    || stringOf(outer.aggregatedOutput) || stringOf(outer.stdout) || stringOf(outer.output) || undefined;
  if (structured !== undefined) return { payload: structured, ...(text === undefined ? {} : { text }) };
  if (text !== undefined) return { payload: parseJson(text) ?? output, text };
  return { payload: output };
}

function builtinKind(call: ToolCallContext): BuiltinKind | undefined {
  const name = call.name.toLowerCase();
  const input = record(call.input);
  if (name.endsWith("permissions/requestapproval")) return "permissions";
  if (stringOf(call.args.command) !== undefined || stringOf(call.args.cmd) !== undefined || name === "commandexecution" || name === "bash") return "command";
  if (Array.isArray(input.changes) || (pathOf(call.args) !== undefined && /write|edit|patch/.test(name))) return "edit";
  if (pathOf(call.args) !== undefined && /read|view|cat/.test(name)) return "read";
  if (/todo|plan/.test(name)) return "plan";
  if (name === "task" || name === "agent" || /subagent/.test(name)) return "subagent";
  if (stringOf(call.args.url) !== undefined && /fetch|browse|web/.test(name)) return "web";
  if ((stringOf(call.args.pattern) ?? stringOf(call.args.query)) !== undefined && /grep|glob|search|find/.test(name)) return "search";
  return undefined;
}

// ---------------------------------------------------------------------------
// Generic fallbacks
// ---------------------------------------------------------------------------

/** Verb forms for reading `verb_object` tool names: [imperative, present, past]. */
const VERBS: Readonly<Record<string, readonly [string, string, string]>> = {
  add: ["Add", "Adding", "Added"], archive: ["Archive", "Archiving", "Archived"], assign: ["Assign", "Assigning", "Assigned"],
  call: ["Call", "Calling", "Called"], check: ["Check", "Checking", "Checked"], close: ["Close", "Closing", "Closed"],
  comment: ["Comment on", "Commenting on", "Commented on"], create: ["Create", "Creating", "Created"],
  delete: ["Delete", "Deleting", "Deleted"], download: ["Download", "Downloading", "Downloaded"], edit: ["Edit", "Editing", "Edited"],
  execute: ["Execute", "Executing", "Executed"], fetch: ["Fetch", "Fetching", "Fetched"], find: ["Find", "Finding", "Found"],
  get: ["Get", "Getting", "Got"], list: ["List", "Listing", "Listed"], lookup: ["Look up", "Looking up", "Looked up"],
  merge: ["Merge", "Merging", "Merged"], move: ["Move", "Moving", "Moved"], open: ["Open", "Opening", "Opened"],
  post: ["Post", "Posting", "Posted"], publish: ["Publish", "Publishing", "Published"], query: ["Query", "Querying", "Queried"],
  read: ["Read", "Reading", "Read"], remove: ["Remove", "Removing", "Removed"], reply: ["Reply to", "Replying to", "Replied to"],
  request: ["Request", "Requesting", "Requested"], run: ["Run", "Running", "Ran"], search: ["Search", "Searching", "Searched"],
  send: ["Send", "Sending", "Sent"], set: ["Set", "Setting", "Set"], update: ["Update", "Updating", "Updated"],
  upload: ["Upload", "Uploading", "Uploaded"], write: ["Write", "Writing", "Wrote"],
};

const TENSE_INDEX: Readonly<Record<Tense, 0 | 1 | 2>> = { imperative: 0, present: 1, past: 2 };

/** Argument names that say where a tool acted, read as "in <value>". */
function locationOf(args: Readonly<Record<string, unknown>>): string | undefined {
  const owner = stringOf(args.owner);
  const repo = stringOf(args.repo) ?? stringOf(args.repository);
  if (repo !== undefined) return owner !== undefined && !repo.includes("/") ? `${owner}/${repo}` : repo;
  const query = stringOf(args.q) ?? stringOf(args.query);
  const qualified = query === undefined ? undefined : /(?:^|\s)repo:(\S+)/.exec(query)?.[1];
  if (qualified !== undefined) return qualified;
  const channel = stringOf(args.channel) ?? stringOf(args.channel_name);
  if (channel !== undefined) return channel.startsWith("#") || /^[CGD][A-Z0-9]{6,}$/.test(channel) ? channel : `#${channel}`;
  return stringOf(args.project) ?? stringOf(args.team) ?? stringOf(args.database) ?? stringOf(args.space);
}

/** Reads an MCP tool name as verb + object, with the location if one is given. */
const GENERIC_MCP: ToolFormatter = {
  icon: "plugs-fill",
  label(call, tense) {
    const words = splitWords(call.name);
    const verb = VERBS[words[0] ?? ""];
    const location = locationOf(call.args);
    const suffix = location === undefined ? "" : ` in ${location}`;
    if (verb !== undefined && words.length > 1) return `${verb[TENSE_INDEX[tense]]} ${words.slice(1).join(" ")}${suffix}`;
    const tool = humanize(call.name);
    return `${tense === "imperative" ? "Run" : tense === "present" ? "Running" : "Ran"} ${tool}${suffix}`;
  },
  summary: (call) => countSummary(call.payload),
  approval(call) {
    const action = GENERIC_MCP.label!(call, "imperative")!;
    return { action, consequence: `Calls ${call.name} on the ${call.server ?? "connected"} server` };
  },
};

/** Any tool nothing else recognizes: "Ran <tool>: <first argument>". */
const GENERIC_TOOL: ToolFormatter = {
  icon: "wrench-fill",
  label(call, tense) {
    const first = firstArgument(call.args);
    const verb = tense === "imperative" ? "Run" : tense === "present" ? "Running" : "Ran";
    return `${verb} ${humanize(call.name)}${first === undefined ? "" : `: ${first}`}`;
  },
  summary: (call) => countSummary(call.payload),
};

function firstArgument(args: Readonly<Record<string, unknown>>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim() !== "") return truncate(value.trim().split("\n")[0]!, 48);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

/** Collection keys whose length is the natural result count. */
const COLLECTION_KEYS = ["items", "issues", "results", "nodes", "edges", "data", "matches", "entries", "files", "messages", "records", "pullRequests", "pull_requests"];

/** "4 results" / "2 rows" from common result shapes; undefined when no count is evident. */
export function countSummary(payload: unknown): string | undefined {
  if (Array.isArray(payload)) return plural(payload.length, "result");
  const value = record(payload);
  const total = numberOf(value.total_count) ?? numberOf(value.totalCount) ?? numberOf(value.total);
  if (total !== undefined) return plural(total, "result");
  if (Array.isArray(value.rows)) return plural(value.rows.length, "row");
  for (const key of COLLECTION_KEYS) if (Array.isArray(value[key])) return plural((value[key] as unknown[]).length, "result");
  return undefined;
}

function errorSummary(call: ToolCallContext): string | undefined {
  const output = record(call.output);
  const error = stringOf(record(output.error).message) ?? stringOf(output.error) ?? stringOf(output.stderr) ?? call.text;
  const exitCode = numberOf(output.exitCode) ?? numberOf(output.exit_code);
  if (exitCode !== undefined && exitCode !== 0) return `exit ${exitCode}`;
  return error === undefined ? undefined : truncate(error.trim().split("\n")[0]!, 120);
}

// ---------------------------------------------------------------------------
// Default registry
// ---------------------------------------------------------------------------

/** The formatters Rack ships. Feature code may register more on its own registry. */
export function createDefaultRegistry(): ToolFormatterRegistry {
  const registry = new ToolFormatterRegistry();

  // Built-in kinds, recognized by shape on any runtime.
  registry.registerBuiltin("command", {
    icon: (call) => PROGRAM_ICONS[shellCommand(commandOf(call) ?? "").program] ?? "terminal-window-fill",
    // The agent's own description of a command ("Push the branch") reads
    // better than the command line; otherwise show the meaningful command,
    // without `cd ... &&` or environment prefixes.
    label: (call, tense) => stringOf(call.args.description)
      ?? `${pick(tense, "Run", "Running", "Ran")} ${truncate(shellCommand(commandOf(call) ?? "").text || "a command", 60)}`,
    summary(call) {
      const lines = call.text === undefined ? 0 : call.text.trimEnd().split("\n").filter((line) => line !== "").length;
      return lines === 0 ? undefined : plural(lines, "line");
    },
    approval(call) {
      const cwd = stringOf(call.args.cwd);
      const description = stringOf(call.args.description);
      return { action: description ?? `Run ${truncate(shellCommand(commandOf(call) ?? "").text || "a command", 80)}`,
        ...(cwd === undefined ? description === undefined ? {} : { consequence: truncate(commandOf(call) ?? "", 120) } : { consequence: `Runs in ${cwd}` }) };
    },
  });
  registry.registerBuiltin("read", {
    icon: (call) => fileIcon(pathOf(call.args)) ?? "file-text-fill",
    label: (call, tense) => `${pick(tense, "Read", "Reading", "Read")} ${basename(pathOf(call.args)!)}`,
    summary: (call) => call.text === undefined ? undefined : plural(call.text.split("\n").length, "line"),
  });
  registry.registerBuiltin("edit", {
    icon: (call) => {
      const changes = record(call.input).changes;
      const paths = Array.isArray(changes) ? changes.map((change) => stringOf(record(change).path)) : [pathOf(call.args)];
      return paths.length === 1 ? fileIcon(paths[0]) ?? "pencil-simple-fill" : "pencil-simple-fill";
    },
    label(call, tense) {
      const changes = record(call.input).changes;
      const target = Array.isArray(changes) ? changes.length === 1 ? basename(stringOf(record(changes[0]).path) ?? "file") : `${changes.length} files` : basename(pathOf(call.args)!);
      return `${pick(tense, "Edit", "Editing", "Edited")} ${target}`;
    },
    approval(call) {
      const changes = record(call.input).changes;
      const paths = Array.isArray(changes) ? changes.map((change) => stringOf(record(change).path) ?? "file") : [pathOf(call.args) ?? "a file"];
      return { action: `Edit ${paths.length === 1 ? basename(paths[0]!) : `${paths.length} files`}`, consequence: `Writes to ${paths.join(", ")}` };
    },
  });
  registry.registerBuiltin("search", {
    icon: "magnifying-glass-fill",
    label: (call, tense) => `${pick(tense, "Search for", "Searching for", "Searched for")} "${truncate(stringOf(call.args.pattern) ?? stringOf(call.args.query) ?? "", 40)}"`,
    summary(call) {
      if (call.text === undefined) return undefined;
      const matches = call.text.split("\n").filter((line) => line.trim() !== "").length;
      return matches === 0 ? "No matches" : plural(matches, "match", "matches");
    },
  });
  registry.registerBuiltin("web", {
    icon: "globe-fill",
    label: (call, tense) => `${pick(tense, "Fetch", "Fetching", "Fetched")} ${hostOf(stringOf(call.args.url)!)}`,
  });
  registry.registerBuiltin("plan", {
    icon: "list-checks-fill",
    label: (_call, tense) => pick(tense, "Update the plan", "Updating the plan", "Updated the plan"),
  });
  registry.registerBuiltin("subagent", {
    icon: "robot-fill",
    label: (call, tense) => {
      const description = stringOf(call.args.description);
      return `${pick(tense, "Start", "Running", "Ran")} a subagent${description === undefined ? "" : `: ${truncate(description, 48)}`}`;
    },
  });
  registry.registerBuiltin("permissions", {
    icon: "lock-simple-fill",
    label: (_call, tense) => pick(tense, "Grant additional permissions", "Requesting additional permissions", "Requested additional permissions"),
  });

  // MCP servers: icons for the integrations shown most often.
  registry.registerServer(["github"], { icon: "brand-github" });
  registry.registerServer(["slack"], { icon: "brand-slack" });
  registry.registerServer(["linear"], { icon: "brand-linear" });
  const database: ToolFormatter = {
    icon: "database-fill",
    label(call, tense) {
      const sql = stringOf(call.args.sql) ?? stringOf(call.args.query) ?? stringOf(call.args.statement);
      const table = sql === undefined ? undefined : /\b(?:from|into|update)\s+["`]?([\w.]+)/i.exec(sql)?.[1];
      if (table === undefined) return undefined;
      return `${pick(tense, "Query", "Querying", "Queried")} ${table.split(".").at(-1)!.replace(/_/g, " ")}`;
    },
  };
  registry.registerServer(["database", "db"], database);
  registry.registerServer(["postgres", "postgresql"], { ...database, icon: "brand-postgres" });
  registry.registerServer(["mysql"], { ...database, icon: "brand-mysql" });
  registry.registerServer(["sqlite"], { ...database, icon: "brand-sqlite" });
  registry.registerServer(["supabase"], { ...database, icon: "brand-supabase" });
  // Brand marks for common MCP integrations; their tools read through the generic verb + object labels.
  for (const [servers, icon] of MCP_SERVER_ICONS) registry.registerServer(servers, { icon });
  registry.registerServer(["rack"], { icon: "globe-fill" });

  registry.registerTool("github", ["search_issues", "search_pull_requests"], {
    summary(call) {
      const value = record(call.payload);
      const count = numberOf(value.total_count) ?? (Array.isArray(value.items) ? value.items.length : undefined);
      return count === undefined ? undefined : plural(count, "result");
    },
  });
  registry.registerTool("linear", ["get_project"], {
    label(call, tense) {
      const name = stringOf(call.args.name) ?? stringOf(call.args.query) ?? stringOf(call.args.id);
      return `${pick(tense, "Read", "Reading", "Read")} ${name === undefined ? "the project" : `the ${truncate(name, 40)} project`}`;
    },
    summary(call) {
      const value = record(call.payload);
      const issues = Array.isArray(value.issues) ? value.issues : record(value.issues).nodes;
      if (!Array.isArray(issues)) return undefined;
      const blocked = issues.filter((issue) => /blocked/i.test(stateName(issue))).length;
      return blocked > 0 ? `${blocked} blocked` : plural(issues.length, "issue");
    },
  });
  registry.registerTool("slack", ["post_message", "chat_post_message", "send_message", "chat_postmessage"], {
    label(call, tense) {
      const channel = locationOf(call.args) ?? "a channel";
      return tense === "imperative" ? `Post a message to ${channel}` : `${pick(tense, "Post", "Posting", "Posted")} to ${channel}`;
    },
    approval(call) {
      const channel = locationOf(call.args) ?? "the channel";
      const sender = stringOf(call.args.username) ?? stringOf(call.args.as_user) ?? "the connected Slack account";
      return { action: `Post a message to ${channel}`, consequence: `Sends as ${sender} to everyone in ${channel}` };
    },
    summary: (call) => call.isError ? undefined : "Sent",
  });
  registry.registerTool("rack", ["rack_browser"], {
    label(call, tense) {
      const action = stringOf(call.args.action);
      const url = stringOf(call.args.url);
      switch (action) {
        case "navigate": return `${pick(tense, "Open", "Opening", "Opened")} ${url === undefined ? "a page" : hostOf(url)}`;
        case "snapshot": return pick(tense, "Read the page", "Reading the page", "Read the page");
        case "click": return pick(tense, "Click on the page", "Clicking on the page", "Clicked on the page");
        case "type": return pick(tense, "Type on the page", "Typing on the page", "Typed on the page");
        default: return `${pick(tense, "Use", "Using", "Used")} the browser`;
      }
    },
  });
  return registry;
}



// ---------------------------------------------------------------------------
// Merged rows: consecutive calls that share an icon
// ---------------------------------------------------------------------------

export type ListItem =
  | { readonly kind: "call"; readonly id: string }
  /** Two or more consecutive calls sharing an icon, keyed by the first call so the row is stable as the run grows. */
  | { readonly kind: "cluster"; readonly key: string; readonly ids: readonly string[] }
  | { readonly kind: "thought"; readonly index: number };

/**
 * What the list shows, in order: consecutive calls that share an icon (the
 * same program, file type or integration) merge into one item; a thought
 * or a call with an approval ends the run and stands alone, so a decision is
 * never hidden inside a merged row. Pure, for tests.
 */
export function mergeSimilarCalls(entries: readonly ToolGroupEntry[], calls: Readonly<Record<string, ToolCall>>, iconOf: (callId: string) => IconName | undefined): readonly ListItem[] {
  const items: ListItem[] = [];
  let run: { icon: IconName; ids: string[] } | undefined;
  const flush = () => {
    if (run !== undefined) items.push(run.ids.length >= 2 ? { kind: "cluster", key: run.ids[0]!, ids: run.ids } : { kind: "call", id: run.ids[0]! });
    run = undefined;
  };
  for (const entry of entries) {
    if (entry.kind === "thought") { flush(); items.push(entry); continue; }
    const call = calls[entry.id];
    const iconName = iconOf(entry.id);
    if (call === undefined || iconName === undefined) continue;
    if (call.approval !== undefined || call.approvalOnly) { flush(); items.push({ kind: "call", id: entry.id }); continue; }
    if (run !== undefined && run.icon === iconName) run.ids.push(entry.id);
    else { flush(); run = { icon: iconName, ids: [entry.id] }; }
  }
  flush();
  return items;
}


/** Plural nouns for files of one type, by their icon. */
const FILE_NOUNS: Readonly<Partial<Record<IconName, string>>> = {
  "brand-typescript": "TypeScript files", "brand-javascript": "JavaScript files", "brand-react": "React files", "brand-python": "Python files",
  "brand-rust": "Rust files", "brand-go": "Go files", "brand-markdown": "Markdown files", "brand-json": "JSON files", "brand-css": "CSS files",
  "brand-sass": "Sass files", "brand-html": "HTML files", "brand-yaml": "YAML files", "brand-toml": "TOML files", "brand-bash": "shell scripts",
  "brand-swift": "Swift files", "brand-kotlin": "Kotlin files", "brand-ruby": "Ruby files", "brand-php": "PHP files", "brand-vue": "Vue files",
  "brand-svelte": "Svelte files", "brand-c": "C files", "brand-cpp": "C++ files", "brand-dotnet": "C# files", "brand-dart": "Dart files",
  "brand-lua": "Lua files", "brand-graphql": "GraphQL files", "brand-docker": "Docker files", "brand-npm": "package files",
};

/** Display names of MCP servers for merged rows ("Used Notion 3 times"). */
function serverName(server: string): string {
  const known: Readonly<Record<string, string>> = { github: "GitHub", gitlab: "GitLab", slack: "Slack", linear: "Linear", notion: "Notion", figma: "Figma",
    jira: "Jira", sentry: "Sentry", vercel: "Vercel", stripe: "Stripe", postgres: "Postgres", postgresql: "Postgres", rack: "the browser" };
  return known[normalizeServer(server)] ?? humanize(server);
}

/**
 * Label for consecutive calls merged into one row because they share an
 * icon: "Ran 3 git commands", "Reading 2 TypeScript files", "Read and edited
 * 4 files", "Used Notion 3 times". Display only.
 */
export function clusterLabel(calls: readonly ToolCallContext[], icon: IconName, tense: Tense): string {
  const count = calls.length;
  const kinds = new Set(calls.map((call) => call.server === undefined ? builtinKind(call) ?? "other" : "mcp"));
  const only = kinds.size === 1 ? [...kinds][0] : undefined;
  const fileNoun = FILE_NOUNS[icon] ?? "files";
  if (only === "command") {
    const programs = new Set(calls.map((call) => shellCommand(commandOf(call) ?? "").program));
    const program = programs.size === 1 ? [...programs][0]! : "";
    const noun = PROGRAM_ICONS[program] !== undefined && program !== "" && !["bash", "sh", "zsh"].includes(program) ? `${program} commands` : "commands";
    return `${pick(tense, "Run", "Running", "Ran")} ${count} ${noun}`;
  }
  if (only === "read") return `${pick(tense, "Read", "Reading", "Read")} ${count} ${fileNoun}`;
  if (only === "edit") return `${pick(tense, "Edit", "Editing", "Edited")} ${count} ${fileNoun}`;
  if (kinds.size === 2 && kinds.has("read") && kinds.has("edit")) return `${pick(tense, "Read and edit", "Reading and editing", "Read and edited")} ${count} ${fileNoun}`;
  if (only === "search") return `${pick(tense, "Run", "Running", "Ran")} ${count} searches`;
  if (only === "web") return `${pick(tense, "Fetch", "Fetching", "Fetched")} ${count} pages`;
  if (only === "mcp") {
    const servers = new Set(calls.map((call) => call.server ?? ""));
    if (servers.size === 1) return `${pick(tense, "Use", "Using", "Used")} ${serverName([...servers][0]!)} ${count} times`;
  }
  return `${pick(tense, "Use", "Using", "Used")} ${count} tools`;
}

// ---------------------------------------------------------------------------
// Program, file-type and integration icons
// ---------------------------------------------------------------------------

/** Icon for the program a shell command runs. */
const PROGRAM_ICONS: Readonly<Record<string, IconName>> = {
  git: "brand-git", gh: "brand-github", glab: "brand-gitlab",
  npm: "brand-npm", npx: "brand-npm", pnpm: "brand-pnpm", pnpx: "brand-pnpm", yarn: "brand-yarn", bun: "brand-bun", bunx: "brand-bun",
  node: "brand-nodejs", tsx: "brand-nodejs", "ts-node": "brand-nodejs", deno: "brand-deno", tsc: "brand-typescript",
  python: "brand-python", python3: "brand-python", pip: "brand-python", pip3: "brand-python", uv: "brand-python", poetry: "brand-python", pytest: "brand-python",
  cargo: "brand-rust", rustc: "brand-rust", rustup: "brand-rust", go: "brand-go", gofmt: "brand-go",
  docker: "brand-docker", "docker-compose": "brand-docker", kubectl: "brand-kubernetes", helm: "brand-kubernetes", terraform: "brand-terraform",
  brew: "brand-homebrew", swift: "brand-swift", xcodebuild: "brand-swift", ruby: "brand-ruby", gem: "brand-ruby", bundle: "brand-ruby", rails: "brand-ruby",
  php: "brand-php", composer: "brand-php", dotnet: "brand-dotnet", gradle: "brand-gradle", gradlew: "brand-gradle", mvn: "brand-maven",
  dart: "brand-dart", flutter: "brand-flutter", lua: "brand-lua", psql: "brand-postgres", mysql: "brand-mysql", sqlite3: "brand-sqlite",
  "redis-cli": "brand-redis", mongosh: "brand-mongodb", supabase: "brand-supabase", prisma: "brand-prisma", vercel: "brand-vercel",
  firebase: "brand-firebase", gcloud: "brand-google-cloud", wrangler: "brand-cloudflare", electron: "brand-electron",
  vitest: "brand-vitest", eslint: "brand-eslint", prettier: "brand-prettier", vite: "brand-vite", webpack: "brand-webpack", sass: "brand-sass",
  bash: "brand-bash", sh: "brand-bash", zsh: "brand-bash",
  curl: "globe-fill", wget: "globe-fill", http: "globe-fill",
  ls: "folder-simple-fill", find: "folder-simple-fill", tree: "folder-simple-fill", mkdir: "folder-simple-fill", cp: "folder-simple-fill", mv: "folder-simple-fill",
  cat: "file-text-fill", head: "file-text-fill", tail: "file-text-fill", less: "file-text-fill", wc: "file-text-fill", sed: "file-text-fill",
  grep: "magnifying-glass-fill", rg: "magnifying-glass-fill", ag: "magnifying-glass-fill", rm: "trash-fill",
};

/** Commands that only set up the shell; the next command in a chain says what the call does. */
const SETUP_COMMANDS = new Set(["cd", "pushd", "popd", "export", "set", "source", ".", "echo", "printf", "true", ":", "unset", "alias"]);
/** Wrappers that run the program named after them. */
const WRAPPERS = new Set(["sudo", "time", "env", "nohup", "exec", "command", "nice"]);

/**
 * The meaningful program of a shell command line and the segment it heads:
 * `cd repo && FOO=1 git push -u origin x` is `git` / "git push -u origin x".
 * A shell invoked with `-c`/`-lc` (as Codex runs commands) is unwrapped.
 * Display only: this never decides what runs.
 */
export function shellCommand(line: string): { readonly program: string; readonly text: string } {
  const inner = /^\s*(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(line);
  const source = inner === null ? line : inner[2]!;
  const segments = source.split(/&&|\|\||;|\|/).map((segment) => segment.trim()).filter((segment) => segment !== "");
  let fallback: { program: string; text: string } | undefined;
  for (const segment of segments) {
    const words = segment.split(/\s+/);
    let index = 0;
    while (index < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!) || WRAPPERS.has(words[index]!))) index += 1;
    const word = words[index];
    if (word === undefined) continue;
    const program = word.replace(/^.*\//, "").replace(/^\.\//, "");
    const text = words.slice(index).join(" ");
    if (!SETUP_COMMANDS.has(program)) return { program, text };
    fallback ??= { program, text };
  }
  return fallback ?? { program: "", text: line.trim() };
}

/** Icons for well-known file names, then extensions. */
const FILE_NAME_ICONS: Readonly<Record<string, IconName>> = {
  "dockerfile": "brand-docker", "docker-compose.yml": "brand-docker", "docker-compose.yaml": "brand-docker", "compose.yaml": "brand-docker",
  "package.json": "brand-npm", "package-lock.json": "brand-npm", "pnpm-lock.yaml": "brand-pnpm", "yarn.lock": "brand-yarn", "bun.lockb": "brand-bun",
  "cargo.toml": "brand-rust", "cargo.lock": "brand-rust", "go.mod": "brand-go", "go.sum": "brand-go", "gemfile": "brand-ruby",
  "tsconfig.json": "brand-typescript", ".eslintrc": "brand-eslint", ".prettierrc": "brand-prettier", "schema.prisma": "brand-prisma",
};
const EXTENSION_ICONS: Readonly<Record<string, IconName>> = {
  ts: "brand-typescript", mts: "brand-typescript", cts: "brand-typescript", tsx: "brand-react", jsx: "brand-react",
  js: "brand-javascript", mjs: "brand-javascript", cjs: "brand-javascript", py: "brand-python", rs: "brand-rust", go: "brand-go",
  md: "brand-markdown", mdx: "brand-markdown", json: "brand-json", jsonc: "brand-json", css: "brand-css", scss: "brand-sass", sass: "brand-sass",
  html: "brand-html", htm: "brand-html", vue: "brand-vue", svelte: "brand-svelte", swift: "brand-swift", kt: "brand-kotlin", kts: "brand-kotlin",
  rb: "brand-ruby", php: "brand-php", yml: "brand-yaml", yaml: "brand-yaml", toml: "brand-toml", sh: "brand-bash", bash: "brand-bash", zsh: "brand-bash",
  lua: "brand-lua", dart: "brand-dart", c: "brand-c", h: "brand-c", cpp: "brand-cpp", cc: "brand-cpp", hpp: "brand-cpp", cs: "brand-dotnet",
  graphql: "brand-graphql", gql: "brand-graphql", prisma: "brand-prisma", sql: "database-fill", tf: "brand-terraform",
};

/** Icon for a file path by name, then extension; undefined when unknown. */
export function fileIcon(path: string | undefined): IconName | undefined {
  if (path === undefined) return undefined;
  const name = basename(path).toLowerCase();
  if (FILE_NAME_ICONS[name] !== undefined) return FILE_NAME_ICONS[name];
  if (/^(vite|vitest)\.config\./.test(name)) return "brand-vite";
  if (/^tailwind\.config\./.test(name)) return "brand-tailwind";
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  return EXTENSION_ICONS[extension];
}

/** MCP servers shown with their brand mark (names are normalized when registered). */
const MCP_SERVER_ICONS: readonly (readonly [readonly string[], IconName])[] = [
  [["git"], "brand-git"], [["gitlab"], "brand-gitlab"], [["notion"], "brand-notion"], [["figma"], "brand-figma"],
  [["jira"], "brand-jira"], [["atlassian"], "brand-atlassian"], [["confluence"], "brand-confluence"], [["sentry"], "brand-sentry"],
  [["vercel"], "brand-vercel"], [["stripe"], "brand-stripe"], [["googledrive", "gdrive", "drive"], "brand-google-drive"],
  [["gmail"], "brand-gmail"], [["googlecalendar", "gcal", "calendar"], "brand-google-calendar"], [["discord"], "brand-discord"],
  [["asana"], "brand-asana"], [["hubspot"], "brand-hubspot"], [["cloudflare"], "brand-cloudflare"], [["puppeteer"], "brand-puppeteer"],
  [["playwright", "browser", "fetch"], "globe-fill"], [["redis"], "brand-redis"], [["mongodb", "mongo"], "brand-mongodb"],
  [["prisma"], "brand-prisma"], [["firebase"], "brand-firebase"], [["docker"], "brand-docker"], [["kubernetes", "k8s"], "brand-kubernetes"],
  [["terraform"], "brand-terraform"], [["filesystem", "files"], "folder-simple-fill"],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick(tense: Tense, imperative: string, present: string, past: string): string {
  return tense === "imperative" ? imperative : tense === "present" ? present : past;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function commandOf(call: ToolCallContext): string | undefined {
  const command = call.args.command ?? call.args.cmd;
  return typeof command === "string" ? command : Array.isArray(command) ? command.join(" ") : undefined;
}

function pathOf(args: Readonly<Record<string, unknown>>): string | undefined {
  return stringOf(args.file_path) ?? stringOf(args.path) ?? stringOf(args.filePath) ?? stringOf(args.notebook_path);
}

function stateName(issue: unknown): string {
  const value = record(issue);
  const state = value.state ?? value.status;
  return typeof state === "string" ? state : stringOf(record(state).name) ?? "";
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== "").at(-1) ?? path;
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return truncate(url, 48); }
}

function splitWords(name: string): string[] {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_\-./]+/).filter((word) => word !== "");
}

export function humanize(name: string): string {
  const words = splitWords(name).join(" ");
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

function normalizeServer(server: string): string {
  return server.toLowerCase().replace(/[-_]?mcp[-_]?/g, "").replace(/[^a-z0-9]/g, "");
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/-/g, "_");
}

/** Slack tools are often named `slack_post_message`; match them as `post_message`. */
function stripServerPrefix(name: string, server: string): string {
  return name.startsWith(`${server}_`) ? name.slice(server.length + 1) : name;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try { return JSON.parse(trimmed) as unknown; } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Raw details for the expanded row: arguments, output (text when available) and error. */
export function callDetails(call: ToolCallContext, rawInput: unknown): readonly { readonly label: string; readonly text: string; readonly kind: "json" | "text" }[] {
  const sections: { label: string; text: string; kind: "json" | "text" }[] = [];
  const command = commandOf(call);
  if (command !== undefined) sections.push({ label: "Command", text: command, kind: "text" });
  else sections.push({ label: "Arguments", text: formatValue(Object.keys(call.args).length > 0 ? call.args : rawInput), kind: "json" });
  if (call.isError) {
    const output = record(call.output);
    const error = stringOf(record(output.error).message) ?? stringOf(output.error) ?? stringOf(output.stderr);
    if (error !== undefined) sections.push({ label: "Error", text: error, kind: "text" });
  }
  if (call.text !== undefined) {
    // JSON text (typical of MCP results) reads better indented.
    const json = parseJson(call.text);
    sections.push(json === undefined ? { label: "Output", text: call.text, kind: "text" } : { label: "Output", text: JSON.stringify(json, null, 2), kind: "json" });
  }
  else if (call.output !== undefined) sections.push({ label: "Output", text: formatValue(call.output), kind: "json" });
  return sections;
}

/**
 * Shared default registry used by the session view. Built last: the default
 * formatters read the icon tables declared above when they are registered.
 */
export const defaultToolFormatters = createDefaultRegistry();
