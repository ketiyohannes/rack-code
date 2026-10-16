/** Filesystem skill discovery and skill-only Claude plugins. We never import
 * another CLI's auth, hooks or settings to make its installed skills visible.
 * Symlinks retain relative scripts/assets; original installations are read only.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeSkill, SkillCatalog } from "../../core/execution/types.js";

export const skillId = (provider: string, path: string): string => `${provider}:${createHash("sha256").update(path).digest("hex")}`;
/** Roots contain skills, rather than configuration or credential files. */
export function codexSkillRoots(): string[] {
  return [...new Set([join(homedir(), ".agents", "skills"), join(homedir(), ".codex", "skills"), ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, "skills")] : [])])];
}

/** Scan personal/account skills and the selected folder's ancestor skills. */
export async function claudeSkills(cwd: string, accountDirectory: string, userHome = homedir()): Promise<SkillCatalog> {
  const roots = [join(accountDirectory, "skills"), join(userHome, ".claude", "skills")];
  const pluginRoots = new Set<string>();
  const registryErrors: string[] = [];
  // Installed plugin registries contain locations, not auth or executable settings.
  // Respect project installation scope while letting the user explicitly select
  // a locally installed skill even when another CLI normally loads the plugin.
  for (const directory of new Set([accountDirectory, join(userHome, ".claude")])) {
    const registry = join(directory, "plugins", "installed_plugins.json");
    try {
      if ((await stat(registry)).size > 1048576) throw new Error("Plugin registry is too large.");
      const stored: unknown = JSON.parse(await readFile(registry, "utf8"));
      const plugins = (stored as { plugins?: Record<string, unknown> }).plugins;
      if (!plugins || typeof plugins !== "object") continue;
      for (const installations of Object.values(plugins)) {
        if (!Array.isArray(installations)) continue;
        for (const entry of installations) {
          if (typeof entry?.installPath !== "string") continue;
          if (typeof entry.projectPath === "string" && resolve(cwd) !== resolve(entry.projectPath) && !resolve(cwd).startsWith(resolve(entry.projectPath) + (process.platform === "win32" ? "\\" : "/"))) continue;
          const root = join(entry.installPath, "skills");
          roots.push(root); pluginRoots.add(root);
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") registryErrors.push("An installed Claude plugin registry could not be read."); }
  }
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    roots.push(join(folder, ".claude", "skills"));
    if (dirname(folder) === folder) break;
  }
  const skills = new Map<string, RuntimeSkill>(); const errors: string[] = [...registryErrors];
  for (const root of new Set(roots)) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`Cannot read skills in ${root}.`); continue; }
    for (const entry of entries.slice(0, 1000)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        const path = await realpath(join(root, entry.name, "SKILL.md"));
        if (skills.has(path)) continue;
        if ((await stat(path)).size > 262144) throw new Error("SKILL.md exceeds 256 KiB.");
        const content = await readFile(path, "utf8");
        const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
        if (!front) throw new Error("Missing skill frontmatter.");
        const field = (key: string): string => {
          const value = new RegExp(`^${key}:\\s*(.*(?:\\n[ \\t]+.*)*)`, "m").exec(front)?.[1]?.trim() ?? "";
          return value.replace(/^[>|][-+]?\s*/, "").replace(/^(['"])([\s\S]*)\1$/, "$2").replace(/\s+/g, " ").trim();
        };
        const name = field("name") || basename(dirname(path));
        skills.set(path, { id: skillId("claude", path), name, description: field("description"), path,
          source: pluginRoots.has(root) ? "Plugin" : root === join(accountDirectory, "skills") ? "Account" : root === join(userHome, ".claude", "skills") ? "Personal" : "Project", enabled: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${entry.name}: ${error instanceof Error ? error.message : "Cannot load skill."}`); }
    }
  }
  return { skills: [...skills.values()], errors };
}

/** A turn-scoped native plugin for explicit selections, preserving all resources.
 * Each skill gets its own namespace, so duplicate user/project names cannot
 * invoke the wrong instructions. Cleanup is owned by the query's finally block.
 */
export async function claudeSkillPlugins(skills: readonly RuntimeSkill[]) {
  if (!skills.length) return { plugins: [] as { type: "local"; path: string }[], names: [] as string[], close: async () => {} };
  const root = await mkdtemp(join(tmpdir(), "rack-skills-"));
  const plugins: { type: "local"; path: string }[] = []; const names: string[] = [];
  try {
    for (const skill of skills) {
      const name = `rack-${createHash("sha256").update(skill.path).digest("hex").slice(0, 16)}`;
      const path = join(root, name);
      await mkdir(join(path, ".claude-plugin"), { recursive: true });
      await mkdir(join(path, "skills"));
      await writeFile(join(path, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "Explicitly selected installed skill" }));
      await symlink(dirname(skill.path), join(path, "skills", "selected"), process.platform === "win32" ? "junction" : "dir");
      plugins.push({ type: "local", path }); names.push(`${name}:${skill.name}`);
    }
    return { plugins, names, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
