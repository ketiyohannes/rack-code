import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryRuntimeContextResolver } from "./directory-runtime-context-resolver.js";

test("linked CLI contexts do not create or chmod user directories; private contexts remain isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-existing-context-"));
  const before = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  try {
    process.env.CLAUDE_CONFIG_DIR = join(root, "external-claude");
    process.env.CODEX_HOME = join(root, "external-codex");
    const resolver = new DirectoryRuntimeContextResolver(join(root, "private"));
    assert.equal((await resolver.resolve("local-claude-login")).directory, process.env.CLAUDE_CONFIG_DIR);
    assert.equal((await resolver.resolve("local-codex-login")).directory, process.env.CODEX_HOME);
    await assert.rejects(stat(process.env.CLAUDE_CONFIG_DIR), { code: "ENOENT" });
    const privateContext = await resolver.resolve("ctx-private");
    assert.ok(privateContext.directory.startsWith(join(root, "private")));
    assert.ok((await stat(privateContext.directory)).isDirectory());
  } finally {
    if (before.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before.claude;
    if (before.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before.codex;
    await rm(root, { recursive: true, force: true });
  }
});
