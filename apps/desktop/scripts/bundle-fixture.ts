/**
 * Bundles one native Electron fixture from `scripts/<name>.ts` into
 * `dist/<name>.mjs`, compiling workspace packages in and keeping third-party
 * packages external (see `esbuild-workspace.ts`).
 *
 * Fixtures load `dist/preload.cjs` and `dist/renderer/index.html`, so the
 * desktop build must run first; `npm run build` empties `dist/`, which also
 * removes previously bundled fixtures.
 *
 * Usage: tsx scripts/bundle-fixture.ts <fixture-name>
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { externalizeThirdPartyPackages } from "./esbuild-workspace.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
if (name === undefined || !/^[a-z0-9-]+$/.test(name) || !existsSync(join(appRoot, "scripts", `${name}.ts`))) {
  console.error("Usage: tsx scripts/bundle-fixture.ts <fixture-name>");
  process.exit(1);
}

await build({
  entryPoints: [join(appRoot, "scripts", `${name}.ts`)],
  outfile: join(appRoot, "dist", `${name}.mjs`),
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [externalizeThirdPartyPackages],
  logLevel: "warning",
});
