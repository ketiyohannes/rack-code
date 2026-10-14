/**
 * Packages the desktop app for the current platform and architecture into
 * `release/`, using @electron/packager.
 *
 * Decisions:
 * - The renderer, main, preload, and host bundles come from
 *   `npm run build:desktop` (run first by the `package` script).
 * - asar is disabled. The Claude Agent SDK runs a native `claude` binary
 *   from its platform package, and an executable cannot be launched from
 *   inside an asar archive.
 * - Only runtime files ship: sources, docs, scripts, and development
 *   dependencies are excluded (packager prunes devDependencies).
 * - On macOS the bundle is ad-hoc signed (`codesign -s -`) so the modified
 *   Electron bundle has a consistent local signature. This is not a
 *   distribution signature or notarization.
 *
 * Usage: tsx scripts/package-desktop.ts
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packager } from "@electron/packager";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const appPaths = await packager({
  dir: root,
  out: join(root, "release"),
  name: "Thinking and Code",
  appBundleId: "local.thinking-and-code",
  appCategoryType: "public.app-category.developer-tools",
  platform: process.platform,
  arch: process.arch,
  overwrite: true,
  asar: false,
  prune: true,
  ignore: [
    /^\/(src|docs|scripts|dist|release)(\/|$)/,
    /^\/(tsconfig[^/]*\.json|AGENTS\.md|\.gitignore)$/,
  ],
});

for (const appPath of appPaths) {
  if (process.platform === "darwin") {
    const bundle = join(appPath, "Thinking and Code.app");
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });
    console.log(`Packaged ${bundle}`);
  } else {
    console.log(`Packaged ${appPath}`);
  }
}
