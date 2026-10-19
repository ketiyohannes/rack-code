/** Side-chat prompts keep hidden context out of the visible question and bound what is sent. */
import assert from "node:assert/strict";
import test from "node:test";
import type { PullDetail } from "../../../features/pull-requests/index.js";
import { CONTEXT_MARKER, MAX_CONTEXT_CHARS, sideChatPrompt, visiblePrompt } from "./side-chat-prompt.js";
import { pullRequestSideChatContext } from "./side-chat-contexts.js";

const detail = (patch: string): PullDetail => ({
  pull: { id: 7, title: "Fix setup", body: "Why it matters", url: "https://github.com/o/r/pull/7", author: "alice", state: "open", draft: false,
    source: "fix/setup", target: "main", head: "h1", base: "b1", updatedAt: "2026-10-19T00:00:00Z" },
  diff: "", files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch }, { path: "dist/bundle.js", status: "added", additions: 9000, deletions: 0 }],
  checks: [], comments: [], truncated: false,
});

test("the visible question excludes hidden context, and oversized context is bounded with a notice", () => {
  const prompt = sideChatPrompt("What changed?", "x".repeat(MAX_CONTEXT_CHARS + 10));
  assert.equal(visiblePrompt(prompt), "What changed?");
  assert.ok(prompt.includes(CONTEXT_MARKER));
  assert.match(prompt, /Context shortened by Rack/);
  assert.equal(sideChatPrompt("Hi", undefined), "Hi");
});

test("PR context carries the description, file list and patches, and marks unavailable patches", async () => {
  const context = pullRequestSideChatContext("github.com/o/r", detail("@@ -1 +1 @@\n-old\n+new"));
  assert.equal(context.key, "pr:github.com/o/r#7");
  const text = await context.context(true);
  assert.match(text ?? "", /Why it matters/);
  assert.match(text ?? "", /src\/a\.ts \(\+1 −1\)/);
  assert.match(text ?? "", /dist\/bundle\.js .*patch not available/);
  assert.match(text ?? "", /\+new/);
  assert.match(text ?? "", /Do not modify any files/);
});

test("PR patches beyond the context budget are omitted and counted rather than cut mid-file", async () => {
  const huge = `@@ -1 +1 @@\n+${"y".repeat(MAX_CONTEXT_CHARS)}`;
  const text = await pullRequestSideChatContext("github.com/o/r", detail(huge)).context(true) ?? "";
  assert.match(text, /1 more patches omitted/);
  assert.ok(text.length < MAX_CONTEXT_CHARS);
});
