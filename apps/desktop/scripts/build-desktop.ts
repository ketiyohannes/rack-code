/**
 * Bundles the Electron desktop app into `apps/desktop/dist/`.
 *
 * Output layout (paths are relied on by `src/main/entry.ts`):
 *   main.mjs                Electron main process (ESM)
 *   host.mjs                execution host utility process (ESM)
 *   preload.cjs             preload bridge (CommonJS: sandboxed preloads cannot load ESM)
 *   renderer/app.js         `@rack/ui` bundle (browser IIFE, no Node APIs)
 *   renderer/index.html     copied as-is from `@rack/ui`
 *   renderer/styles.css     copied as-is from `@rack/ui`
 *   renderer/fonts/*.woff2  Inter, IBM Plex Mono and Geist Mono, so the strict
 *                           CSP never needs a remote font host
 *   icon.png                the app icon (assets/icon.png), for the Linux window
 *                           and the development Dock
 *
 * Phosphor icon SVGs are imported by the renderer and inlined as text.
 *
 * Type checking is not done here; `npm run typecheck` at the repository root
 * runs tsc in every workspace. Workspace packages export TypeScript sources,
 * so they are compiled into each bundle; third-party packages stay external
 * for main and the host because some (the Claude Agent SDK) locate files
 * relative to their own install directory at runtime (see
 * `esbuild-workspace.ts`). Packaging is done by `package-desktop.ts`.
 *
 * Usage: tsx scripts/build-desktop.ts [--watch]
 */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, context, type BuildOptions } from "esbuild";

import { externalizeThirdPartyPackages } from "./esbuild-workspace.js";

/** `apps/desktop`; bundle entry points and the output live here. */
const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** npm workspaces hoist third-party packages to the repository root. */
const repositoryRoot = join(appRoot, "..", "..");
/** Source directory of the `@rack/ui` workspace package. */
const uiSource = join(dirname(createRequire(import.meta.url).resolve("@rack/ui/package.json")), "src");
const outDirectory = join(appRoot, "dist");
const watch = process.argv.includes("--watch");
// About must describe the built release rather than a separately maintained label.
const { version } = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as { version: string };

const shared: BuildOptions = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "es2022",
};

const targets: BuildOptions[] = [
  {
    ...shared,
    entryPoints: [join(appRoot, "src/main/entry.ts")],
    outfile: join(outDirectory, "main.mjs"),
    platform: "node",
    format: "esm",
    plugins: [externalizeThirdPartyPackages],
  },
  {
    ...shared,
    entryPoints: [join(appRoot, "src/host/entry.ts")],
    outfile: join(outDirectory, "host.mjs"),
    platform: "node",
    format: "esm",
    plugins: [externalizeThirdPartyPackages],
  },
  {
    ...shared,
    entryPoints: [join(appRoot, "src/preload/preload.ts")],
    outfile: join(outDirectory, "preload.cjs"),
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: [join(uiSource, "app.ts")],
    outfile: join(outDirectory, "renderer/app.js"),
    platform: "browser",
    format: "iife",
    loader: { ".svg": "text" },
    define: { __APP_VERSION__: JSON.stringify(version) },
  },
];

/** Bundled fonts and license; font filenames are referenced by styles.css. */
const FONTS: ReadonlyArray<readonly [string, string]> = [
  ["@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "inter-variable.woff2"],
  ["@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2", "geist-mono-variable.woff2"],
  ["@fontsource-variable/geist-mono/LICENSE", "geist-mono-LICENSE.txt"],
  ["@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-mono-400.woff2"],
  ["@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", "ibm-plex-mono-500.woff2"],
];

async function copyStatic(): Promise<void> {
  await mkdir(join(outDirectory, "renderer", "fonts"), { recursive: true });
  await copyFile(join(appRoot, "assets", "icon.png"), join(outDirectory, "icon.png"));
  await copyFile(join(repositoryRoot, "node_modules/@xterm/xterm/css/xterm.css"), join(outDirectory, "renderer/xterm.css"));
  for (const file of ["index.html", "styles.css"]) {
    await copyFile(join(uiSource, file), join(outDirectory, "renderer", file));
  }
  for (const [source, target] of FONTS) {
    await copyFile(join(repositoryRoot, "node_modules", source), join(outDirectory, "renderer", "fonts", target));
  }
}

await rm(outDirectory, { recursive: true, force: true });
await copyStatic();
if (watch) {
  // Static files are copied once; restart the watcher after editing them.
  for (const options of targets) {
    await (await context(options)).watch();
  }
} else {
  await Promise.all(targets.map((options) => build(options)));
}
