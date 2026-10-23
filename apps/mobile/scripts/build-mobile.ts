/**
 * Builds the web controller and stages it for Capacitor in `./www`.
 *
 * Capacitor copies `webDir` verbatim into the native projects, so the web
 * bundle has to be inside this package rather than referenced across the
 * workspace. This script owns that copy, which keeps `capacitor.config.ts`
 * a plain configuration file and means `npm run sync` is always operating
 * on a freshly built bundle instead of whatever was there last.
 *
 * Source maps are dropped. They roughly triple the payload, are of no use
 * inside a shipped app, and exposing the full source of the controller in
 * a store build is not something to do by accident.
 *
 * Usage: tsx scripts/build-mobile.ts
 */
import { cp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(appRoot, "..", "..");
const webDist = join(repositoryRoot, "apps", "web", "dist");
const staging = join(appRoot, "www");

const build = spawnSync("npm", ["run", "build", "--workspace", "@rack/web"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (build.status !== 0) {
  throw new Error("The web controller failed to build; the mobile shell has nothing to package.");
}

await rm(staging, { recursive: true, force: true });
await cp(webDist, staging, { recursive: true });

// Source maps would otherwise be copied along with the bundle.
for (const entry of await readdir(staging)) {
  if (entry.endsWith(".map")) await rm(join(staging, entry));
}

console.log(`[rack-mobile] staged the web controller in ${staging}`);
console.log("[rack-mobile] run `npx cap sync` to copy it into the native projects");
