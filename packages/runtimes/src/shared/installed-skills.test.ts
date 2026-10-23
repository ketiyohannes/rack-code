import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSkills, claudeSkillPlugins } from "./installed-skills.js";

test("Claude skill metadata and resources load without copying personal auth/settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-skill-test-"));
  try {
    const home = join(root, "home"); const account = join(root, "account"); const cwd = join(root, "project", "nested");
    const skill = join(home, ".claude", "skills", "writing");
    await mkdir(skill, { recursive: true }); await mkdir(cwd, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), '---\nname: writing\ndescription: >\n  Draft a clear\n  useful document.\n---\nInstructions');
    await writeFile(join(skill, "resource.txt"), "resource");
    await writeFile(join(home, ".claude", "settings.json"), '{"secret":"never copy"}');
    const discovered = await claudeSkills(cwd, account, home);
    assert.equal(discovered.skills.length, 1); assert.deepEqual(discovered.errors, []);
    assert.equal(discovered.skills[0]!.description, "Draft a clear useful document.");
    const bridge = await claudeSkillPlugins(discovered.skills);
    const path = bridge.plugins[0]!.path;
    try {
      assert.equal(await readFile(join(path, "skills", "selected", "resource.txt"), "utf8"), "resource");
      assert.equal(await realpath(join(path, "skills", "selected", "SKILL.md")), discovered.skills[0]!.path);
      assert.equal(JSON.parse(await readFile(join(path, ".claude-plugin", "plugin.json"), "utf8")).name + ":writing", bridge.names[0]);
      await assert.rejects(readFile(join(path, "settings.json")));
    } finally { await bridge.close(); }
    await assert.rejects(readFile(join(path, ".claude-plugin", "plugin.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude installed plugin skills respect project installation scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-plugin-scope-"));
  try {
    const home = join(root, "home"); const account = join(root, "account"); const cwd = join(root, "project", "nested");
    const global = join(root, "global-plugin"); const other = join(root, "other-plugin");
    await mkdir(join(home, ".claude", "plugins"), { recursive: true }); await mkdir(cwd, { recursive: true });
    for (const plugin of [global, other]) {
      await mkdir(join(plugin, "skills", "writing"), { recursive: true });
      await writeFile(join(plugin, "skills", "writing", "SKILL.md"), "---\nname: writing\ndescription: Draft a document\n---\nInstructions");
    }
    await writeFile(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
      "global@fixture": [{ scope: "user", installPath: global }],
      "other@fixture": [{ scope: "project", projectPath: join(root, "other-project"), installPath: other }],
    } }));
    const catalog = await claudeSkills(cwd, account, home);
    assert.equal(catalog.skills.length, 1); assert.equal(catalog.skills[0]!.source, "Plugin");
    assert.ok(catalog.skills[0]!.path.includes("global-plugin"));
    assert.deepEqual(catalog.errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
