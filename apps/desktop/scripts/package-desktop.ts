/**
 * Packages the desktop app for the current platform and architecture into
 * `apps/desktop/release/`, using @electron/packager.
 *
 * Decisions:
 * - The renderer, main, preload, and host bundles come from
 *   `npm run build` in this workspace (run first by the `package` script).
 * - asar is disabled. The Claude Agent SDK runs a native `claude` binary
 *   from its platform package, and an executable cannot be launched from
 *   inside an asar archive.
 * - npm workspaces hoist every third-party package to the repository root,
 *   so this workspace has no `node_modules` of its own. Packaging therefore
 *   uses a staging directory (`release/.stage/`) containing:
 *     package.json   generated: app name, version, entry point, and the
 *                    third-party runtime dependencies of every workspace
 *                    package the app depends on (transitively);
 *     dist/          a copy of the desktop build;
 *     node_modules   a symlink to the repository root's `node_modules`.
 *   The packager dereferences the symlink while copying and prunes it to
 *   the production dependency tree of the generated package.json, so only
 *   runtime modules ship. Workspace packages are bundled into `dist/` and
 *   are never copied as modules.
 * - The generated manifest keeps the app name `thinking-and-code`. Electron
 *   derives the user-data directory (renderer storage, single-instance
 *   lock) from it, so changing it would orphan existing installations' data.
 * - On macOS the bundle is ad-hoc signed (`codesign -s -`) so the modified
 *   Electron bundle has a consistent local signature. This is not a
 *   distribution signature or notarization.
 *
 * Usage: tsx scripts/package-desktop.ts
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";

import { bundledCodexCommand } from "@rack/runtimes/codex/managed-codex-command";

/** Name Electron uses for the user-data directory; see the module comment. */
const APP_NAME = "thinking-and-code";
const PRODUCT_NAME = "Thinking and Code";
const WORKSPACE_SCOPE = "@rack/";

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(appRoot, "..", "..");
const releaseDirectory = join(appRoot, "release");
const stageDirectory = join(releaseDirectory, ".stage");
const resolveFromApp = createRequire(join(appRoot, "package.json")).resolve;

async function readManifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

/**
 * Collects the third-party `dependencies` of the desktop app and of every
 * workspace package reachable through `dependencies` (not devDependencies).
 * Fails when two packages request different ranges of the same dependency,
 * because the staged manifest can only express one.
 */
async function runtimeDependencies(root: Manifest): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visited = new Set<string>();
  const pending: Manifest[] = [root];
  for (let manifest = pending.pop(); manifest !== undefined; manifest = pending.pop()) {
    if (visited.has(manifest.name)) continue;
    visited.add(manifest.name);
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith(WORKSPACE_SCOPE)) {
        pending.push(await readManifest(resolveFromApp(`${name}/package.json`)));
      } else if (result[name] !== undefined && result[name] !== range) {
        throw new Error(`Conflicting ranges for ${name}: ${result[name]} and ${range}.`);
      } else {
        result[name] = range;
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

// Fail before distributing a build with omitted/mismatched optional binaries.
bundledCodexCommand();

const desktop = await readManifest(join(appRoot, "package.json"));
// The staged manifest has no devDependencies, so the packager cannot infer
// the Electron version from it; use the installed development version.
const electronVersion = (await readManifest(resolveFromApp("electron/package.json"))).version;
await rm(stageDirectory, { recursive: true, force: true });
await mkdir(stageDirectory, { recursive: true });
await writeFile(join(stageDirectory, "package.json"), `${JSON.stringify({
  name: APP_NAME,
  version: desktop.version,
  private: true,
  type: "module",
  main: "dist/main.mjs",
  dependencies: await runtimeDependencies(desktop),
}, null, 2)}\n`);
await cp(join(appRoot, "dist"), join(stageDirectory, "dist"), { recursive: true });
await symlink(join(repositoryRoot, "node_modules"), join(stageDirectory, "node_modules"), "dir");

let appPaths: string[];
try {
  appPaths = await packager({
    dir: stageDirectory,
    electronVersion,
    out: releaseDirectory,
    name: PRODUCT_NAME,
    appBundleId: "local.thinking-and-code",
    appCategoryType: "public.app-category.developer-tools",
    platform: process.platform,
    arch: process.arch,
    overwrite: true,
    asar: false,
    prune: true,
    ignore: [
      // Workspace sources are compiled into dist/; fixtures are test-only.
      /^\/node_modules\/@rack(\/|$)/,
      /^\/node_modules\/\.bin(\/|$)/,
      /^\/dist\/verify-[^/]*$/,
    ],
  });
} finally {
  await rm(stageDirectory, { recursive: true, force: true });
}

for (const appPath of appPaths) {
  // Validate the pruned package, not just the development node_modules tree.
  const resources = process.platform === "darwin"
    ? join(appPath, `${PRODUCT_NAME}.app`, "Contents", "Resources")
    : join(appPath, "resources");
  bundledCodexCommand({ resolve: createRequire(join(resources, "app", "package.json")).resolve });
  if (process.platform === "darwin") {
    const bundle = join(appPath, `${PRODUCT_NAME}.app`);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
    console.log(`Packaged ${bundle}`);
  } else {
    console.log(`Packaged ${appPath}`);
  }
}
