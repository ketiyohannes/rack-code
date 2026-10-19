/**
 * Context builders for side chats (see side-chat.ts and docs/side-chat.md).
 *
 * Each builder returns the hidden text appended to a side-chat prompt. Text is
 * gathered from data the renderer already holds; nothing new is read from the
 * project. The model may read files itself (read-only) when given a path.
 *
 * - Main session: re-sent on every turn because the main conversation moves
 *   on while the side chat is open. Bounded to recent messages.
 * - Pull request: the full description and patches are sent on the first turn
 *   and whenever the PR head commit changes; otherwise a short reminder keeps
 *   prompts small, since the provider thread already holds the earlier context.
 */
import type { PullDetail, ReviewFile } from "../../../features/pull-requests/index.js";
import type { Store } from "../store.js";
import { diffFiles } from "./change-diff.js";
import type { SideChatContext } from "./side-chat.js";
import { MAX_CONTEXT_CHARS } from "./side-chat-prompt.js";

const MESSAGE_CHARS = 2_000, RECENT_MESSAGES = 16;
const HEADS_KEY = "sideChat.contextHeads";

export const EXPLAIN_PROMPT = "Explain this pull request. Cover what it changes and why, how the changed pieces fit together, and anything a reviewer should check closely (risks, missing tests, behavior changes). Reference files by path.";

export function sessionSideChatContext(store: Store, sessionId: string): SideChatContext {
  const state = store.get();
  const session = state.session?.id === sessionId ? state.session : undefined;
  const project = state.projects.find((entry) => entry.id === session?.projectId);
  return {
    key: `session:${sessionId}`,
    title: session?.title ?? "This session",
    ...(project ? { subtitle: project.path.split(/[\\/]/).at(-1) ?? project.path } : {}),
    emptyHint: "Ask about this session without interrupting it. Side chats can read files but never change them.",
    suggestions: [
      { label: "Summarize progress", prompt: "Summarize what the main session has done so far and what is still open.", icon: "list-checks" },
      { label: "Explain the latest change", prompt: "Explain the most recent change the main session made and why.", icon: "sparkle" },
    ],
    context: () => {
      const current = store.get();
      const live = current.session?.id === sessionId ? current.session : undefined;
      const recent = (live?.messages ?? []).filter((message) => message.role === "user" || message.role === "assistant").slice(-RECENT_MESSAGES)
        .map((message) => `[${message.role === "user" ? "User" : "Assistant"}] ${message.content.length > MESSAGE_CHARS ? `${message.content.slice(0, MESSAGE_CHARS)}…` : message.content}`);
      const isolated = live?.workspaceMode === "isolated";
      const folder = isolated ? (current.workspace?.mode === "isolated" && current.workspace.exists ? current.workspace.path : undefined)
        : current.projects.find((entry) => entry.id === live?.projectId)?.path;
      return [
        "Rack side chat. The user is asking a side question about their main agent conversation while it may still be working. Do not modify any files; answer concisely.",
        `Main session: ${live?.title ?? "Untitled"}`,
        folder ? `Project folder (read files here if useful): ${folder}` : isolated
          ? "This session's isolated worktree is not available yet. Do not use the shared checkout as its working files."
          : "The main session is a standalone chat without a project folder.",
        recent.length ? `Recent main conversation, oldest first:\n${recent.join("\n\n")}` : "The main conversation has no messages yet.",
      ].join("\n\n");
    },
  };
}

function loadHeads(): Record<string, string> {
  try { const value = JSON.parse(localStorage.getItem(HEADS_KEY) ?? "{}") as unknown; return value && typeof value === "object" ? value as Record<string, string> : {}; }
  catch { return {}; }
}
function saveHead(key: string, head: string): void {
  try { localStorage.setItem(HEADS_KEY, JSON.stringify({ ...loadHeads(), [key]: head })); } catch { /* Context is simply re-sent next time. */ }
}

/** Per-file changes for context, from host files or a parsed unified diff. */
function changedFiles(detail: PullDetail): readonly ReviewFile[] {
  return detail.files ?? diffFiles(detail.diff).map((file) => ({ path: file.title, status: "modified" as const, additions: file.added, deletions: file.removed, patch: file.lines.join("\n") }));
}

export function pullRequestSideChatContext(repository: string, detail: PullDetail): SideChatContext {
  const { pull } = detail;
  const key = `pr:${repository}#${pull.id}`;
  return {
    key,
    title: `#${pull.id} ${pull.title}`,
    subtitle: repository,
    emptyHint: "Ask about this pull request. Side chats can read files but never change them.",
    suggestions: [
      { label: "Explain with AI", prompt: EXPLAIN_PROMPT, icon: "sparkle" },
      { label: "What should I check?", prompt: "What should I check most carefully when reviewing this pull request, and why?", icon: "list-checks" },
    ],
    context: (firstTurn) => {
      const files = changedFiles(detail);
      const header = [
        "Rack side chat about a pull request under review. Do not modify any files; answer for a code reviewer.",
        `Pull request: ${repository} #${pull.id} — ${pull.title}`,
        `State: ${pull.draft ? "draft" : pull.state}. Author: ${pull.author}. Merging ${pull.source} into ${pull.target}. Head commit: ${pull.head}.`,
      ];
      if (!firstTurn && loadHeads()[key] === pull.head) return [...header, "The description and changes were provided earlier in this conversation and are unchanged."].join("\n\n");
      saveHead(key, pull.head);
      const summary = files.map((file) => `- ${file.status} ${file.previousPath ? `${file.previousPath} → ` : ""}${file.path} (+${file.additions} −${file.deletions})${file.patch === undefined ? " [patch not available: binary or too large]" : ""}`);
      let patches = "", omitted = 0;
      for (const file of files) {
        if (file.patch === undefined) continue;
        const block = `\n\n--- ${file.path}\n${file.patch}`;
        if (patches.length + block.length > MAX_CONTEXT_CHARS * 0.8) { omitted++; continue; }
        patches += block;
      }
      return [
        ...header,
        `Description:\n${pull.body.trim() || "(none)"}`,
        `Changed files (${files.length}${detail.truncated ? ", list may be incomplete" : ""}):\n${summary.join("\n")}`,
        `Patches:${patches || "\n(none available)"}${omitted ? `\n\n[${omitted} more patches omitted for length.]` : ""}`,
      ].join("\n\n");
    },
  };
}
