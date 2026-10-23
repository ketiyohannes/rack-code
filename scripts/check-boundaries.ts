/**
 * Enforces the workspace dependency rules described in
 * `docs/architecture.md` ("Repository layout and package boundaries").
 *
 * For every workspace under `packages/` and `apps/` it scans the TypeScript
 * sources and reports:
 * 1. relative imports that leave the workspace directory (cross-package
 *    code must be imported through a package name);
 * 2. `@rack/*` imports of a package that the workspace does not declare;
 * 3. `@rack/*` imports from shipped source files that are declared only as
 *    devDependencies (tests and the workspace's `scripts/` tooling may use
 *    devDependencies);
 * 4. declared runtime dependencies that the layer rules below forbid.
 *
 * The layer rules point inward: core depends on nothing, adapters and
 * features depend on core, the host composes them, and apps compose
 * everything. No third-party linter is used so the check runs with the
 * existing toolchain.
 *
 * Usage: tsx scripts/check-boundaries.ts   (exit code 1 on any violation)
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_GROUPS = ["packages", "apps"] as const;
const SCOPE = "@rack/";

/**
 * Workspace packages each workspace may list in `dependencies`. A workspace
 * missing from this table may not depend on any other workspace, which
 * forces new packages to be placed in the layering deliberately.
 */
const ALLOWED_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  "@rack/core": [],
  "@rack/features": ["@rack/core"],
  "@rack/contracts": ["@rack/core", "@rack/features"],
  "@rack/runtimes": ["@rack/core"],
  "@rack/node-adapters": ["@rack/core", "@rack/features"],
  "@rack/host": ["@rack/contracts", "@rack/core", "@rack/features", "@rack/node-adapters", "@rack/runtimes"],
  "@rack/client": ["@rack/contracts", "@rack/features"],
  "@rack/ui": ["@rack/client", "@rack/contracts", "@rack/core", "@rack/features"],
  "@rack/desktop": ["@rack/client", "@rack/contracts", "@rack/core", "@rack/features", "@rack/host", "@rack/node-adapters", "@rack/runtimes", "@rack/ui"],
  /** The daemon is the host plus a socket; it must never reach for the interface. */
  "@rack/daemon": ["@rack/contracts", "@rack/host"],
  /** A browser controller is a client; it must never link the host into a page. */
  "@rack/web": ["@rack/client", "@rack/contracts", "@rack/ui"],
  /** A shell around the built web bundle; it imports no workspace code. */
  "@rack/mobile": [],
  /** Infrastructure services. Neither runs agents, so neither may touch core. */
  "@rack/vm-manager": [],
  "@rack/cloud": [],
};

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** Static, dynamic, side-effect and re-export import specifiers. */
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

async function listWorkspaces(): Promise<string[]> {
  const directories: string[] = [];
  for (const group of WORKSPACE_GROUPS) {
    for (const entry of await readdir(join(repositoryRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(repositoryRoot, group, entry.name);
      // A directory without a manifest is documentation, not a workspace.
      if ((await readdir(directory)).includes("package.json")) directories.push(directory);
    }
  }
  return directories;
}

async function listSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Build output, not source: `www` is the web bundle staged for Capacitor.
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "release" || entry.name === "www") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listSources(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** `@rack/core/execution/types` -> `@rack/core`. */
function packageOf(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

const violations: string[] = [];
for (const workspace of await listWorkspaces()) {
  const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as Manifest;
  const runtime = new Set(Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith(SCOPE)));
  const development = new Set(Object.keys(manifest.devDependencies ?? {}).filter((name) => name.startsWith(SCOPE)));
  const allowed = ALLOWED_DEPENDENCIES[manifest.name];

  for (const dependency of runtime) {
    if (allowed === undefined || !allowed.includes(dependency)) {
      violations.push(`${manifest.name}: dependency on ${dependency} is not allowed by the layer rules`);
    }
  }

  for (const file of await listSources(workspace)) {
    const location = relative(repositoryRoot, file);
    // Tests and build/fixture tooling never ship, so they may use devDependencies.
    const mayUseDevelopment = file.endsWith(".test.ts") || relative(workspace, file).startsWith(`scripts${sep}`);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (target !== workspace && !target.startsWith(workspace + sep)) {
          violations.push(`${location}: relative import "${specifier}" leaves ${manifest.name}`);
        }
      } else if (specifier.startsWith(SCOPE)) {
        const target = packageOf(specifier);
        if (target === manifest.name) {
          violations.push(`${location}: imports its own package by name ("${specifier}"); use a relative import`);
        } else if (runtime.has(target)) {
          continue;
        } else if (development.has(target)) {
          if (!mayUseDevelopment) violations.push(`${location}: "${specifier}" is a devDependency of ${manifest.name}; only tests and scripts may import it`);
        } else {
          violations.push(`${location}: "${specifier}" is not declared in ${manifest.name}'s package.json`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`Package boundary violations (${violations.length}):\n${violations.map((line) => `  ${line}`).join("\n")}`);
  process.exit(1);
}
console.log("Package boundaries OK.");
