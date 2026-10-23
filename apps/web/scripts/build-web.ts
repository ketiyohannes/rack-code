/**
 * Bundles the browser controller into `apps/web/dist/`.
 *
 * Output layout (referenced by `src/index.html`):
 *   index.html              copied from this app
 *   app.js                  the controller bundle (browser IIFE)
 *   styles.css              copied from `@rack/ui`
 *   web.css                 pairing screen and connection banner
 *   xterm.css               terminal styles
 *   fonts/*.woff2           bundled so the strict CSP needs no font host
 *
 * This mirrors the renderer half of `apps/desktop/scripts/build-desktop.ts`
 * and deliberately shares its conventions: workspace packages export
 * TypeScript sources and are compiled into the bundle, Phosphor icon SVGs
 * are inlined as text, and no type checking happens here (`npm run
 * typecheck` at the repository root covers every workspace).
 *
 * Unlike the desktop build there are no Node-side bundles at all. The web
 * controller never loads the host; it only speaks the remote protocol.
 *
 * Usage: tsx scripts/build-web.ts [--watch]
 */
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, context, type BuildOptions } from "esbuild";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** npm workspaces hoist third-party packages to the repository root. */
const repositoryRoot = join(appRoot, "..", "..");
const uiSource = join(dirname(createRequire(import.meta.url).resolve("@rack/ui/package.json")), "src");
const outDirectory = join(appRoot, "dist");
const watch = process.argv.includes("--watch");
const { version } = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as { version: string };

const bundle: BuildOptions = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "es2022",
  entryPoints: [join(appRoot, "src/main.ts")],
  outfile: join(outDirectory, "app.js"),
  platform: "browser",
  format: "iife",
  loader: { ".svg": "text" },
  define: { __APP_VERSION__: JSON.stringify(version) },
};

/** Same fonts as the desktop build; filenames are referenced by styles.css. */
const FONTS: ReadonlyArray<readonly [string, string]> = [
  ["@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "inter-variable.woff2"],
  ["@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2", "geist-mono-variable.woff2"],
  ["@fontsource-variable/geist-mono/LICENSE", "geist-mono-LICENSE.txt"],
  ["@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-mono-400.woff2"],
  ["@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", "ibm-plex-mono-500.woff2"],
];

async function copyStatic(): Promise<void> {
  await mkdir(join(outDirectory, "fonts"), { recursive: true });
  await copyFile(join(repositoryRoot, "node_modules/@xterm/xterm/css/xterm.css"), join(outDirectory, "xterm.css"));
  await copyFile(join(uiSource, "styles.css"), join(outDirectory, "styles.css"));
  for (const file of ["index.html", "web.css"]) {
    await copyFile(join(appRoot, "src", file), join(outDirectory, file));
  }
  for (const [source, target] of FONTS) {
    await copyFile(join(repositoryRoot, "node_modules", source), join(outDirectory, "fonts", target));
  }
}

await rm(outDirectory, { recursive: true, force: true });
await copyStatic();
if (watch) {
  // Static files are copied once; restart the watcher after editing them.
  await (await context(bundle)).watch();
} else {
  await build(bundle);
}
