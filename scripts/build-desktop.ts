/**
 * Bundles the Electron desktop app into `dist-desktop/`.
 *
 * Output layout (paths are relied on by `src/desktop/main/entry.ts`):
 *   main.mjs                Electron main process (ESM)
 *   host.mjs                execution host utility process (ESM)
 *   preload.cjs             preload bridge (CommonJS: sandboxed preloads cannot load ESM)
 *   renderer/app.js         renderer bundle (browser IIFE, no Node APIs)
 *   renderer/index.html     copied as-is
 *   renderer/styles.css     copied as-is
 *   renderer/fonts/*.woff2  Inter, IBM Plex Mono and Geist Mono, so the strict
 *                           CSP never needs a remote font host
 *
 * Phosphor icon SVGs are imported by the renderer and inlined as text.
 *
 * Type checking is not done here; `npm run typecheck` runs tsc for the Node
 * and renderer configurations. Node packages stay external for main and the
 * host because some (the Claude Agent SDK) locate files relative to their
 * own install directory at runtime. Packaging for distribution is not
 * covered yet.
 *
 * Usage: tsx scripts/build-desktop.ts [--watch]
 */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, context, type BuildOptions } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDirectory = join(root, "dist-desktop");
const watch = process.argv.includes("--watch");
// About must describe the built release rather than a separately maintained label.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };

const shared: BuildOptions = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "es2022",
};

const targets: BuildOptions[] = [
  {
    ...shared,
    entryPoints: [join(root, "src/desktop/main/entry.ts")],
    outfile: join(outDirectory, "main.mjs"),
    platform: "node",
    format: "esm",
    packages: "external",
  },
  {
    ...shared,
    entryPoints: [join(root, "src/desktop/host/entry.ts")],
    outfile: join(outDirectory, "host.mjs"),
    platform: "node",
    format: "esm",
    packages: "external",
  },
  {
    ...shared,
    entryPoints: [join(root, "src/desktop/preload/preload.ts")],
    outfile: join(outDirectory, "preload.cjs"),
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...shared,
    entryPoints: [join(root, "src/desktop/renderer/app.ts")],
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
  await copyFile(join(root, "node_modules/@xterm/xterm/css/xterm.css"), join(outDirectory, "renderer/xterm.css"));
  for (const file of ["index.html", "styles.css"]) {
    await copyFile(join(root, "src/desktop/renderer", file), join(outDirectory, "renderer", file));
  }
  for (const [source, target] of FONTS) {
    await copyFile(join(root, "node_modules", source), join(outDirectory, "renderer", "fonts", target));
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
