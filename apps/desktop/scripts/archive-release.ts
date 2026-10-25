/**
 * Archives the packaged application into one file per platform, ready to be
 * attached to a GitHub release.
 *
 * `package-desktop.ts` leaves a directory (`Rack.app` on macOS, a folder of
 * binaries elsewhere). A release needs a single file with a name that says
 * what it is, so this step wraps that output and prints the path it wrote.
 *
 * Decisions:
 * - **System archivers, no dependency.** Node has no archive API, and the
 *   release pipeline should not grow one for a step every platform's shell
 *   already performs.
 * - **`ditto` on macOS.** `zip` does not preserve the symlinks inside an
 *   Electron framework or the code signature attached to the bundle; an app
 *   zipped with it can fail to launch after being downloaded. `ditto
 *   -c -k --sequesterRsrc --keepParent` is Apple's documented way to archive
 *   a bundle, and the one `xcrun notarytool` expects.
 * - **`tar` on Windows.** Windows runners ship bsdtar, which writes zip with
 *   `-a`. That avoids a PowerShell dependency for a one-line operation.
 * - **`tar.gz` on Linux**, which preserves the executable bit that zip drops.
 * - **Published names say platform, not kernel.** `macos-arm64` rather than
 *   `darwin-arm64`: the file name is read by people choosing a download.
 *
 * Usage: tsx scripts/archive-release.ts   (prints the archive path)
 */
import { execFileSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_NAME = "Rack";

/** How each platform is named in a published file name. */
const PUBLISHED_PLATFORMS: Readonly<Record<string, string>> = {
  darwin: "macos",
  win32: "windows",
  linux: "linux",
};

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDirectory = join(appRoot, "release");

const { version } = JSON.parse(
  await readFile(join(appRoot, "package.json"), "utf8"),
) as { version: string };

const published = PUBLISHED_PLATFORMS[process.platform];
if (published === undefined) {
  throw new Error(`Rack is not packaged for ${process.platform}.`);
}

// The directory @electron/packager wrote, named after the kernel it built on.
const packaged = join(releaseDirectory, `${PRODUCT_NAME}-${process.platform}-${process.arch}`);
try {
  await stat(packaged);
} catch {
  throw new Error(`${packaged} does not exist. Run "npm run package" first.`);
}

const extension = process.platform === "linux" ? "tar.gz" : "zip";
const archive = join(releaseDirectory, `${PRODUCT_NAME}-${version}-${published}-${process.arch}.${extension}`);
// Archivers append to an existing file rather than replacing it.
await rm(archive, { force: true });

if (process.platform === "darwin") {
  // --keepParent puts Rack.app at the root of the archive, so expanding it
  // yields the bundle itself rather than its contents.
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", join(packaged, `${PRODUCT_NAME}.app`), archive], { stdio: "inherit" });
} else if (process.platform === "win32") {
  execFileSync("tar", ["-a", "-c", "-f", archive, "-C", releaseDirectory, `${PRODUCT_NAME}-${process.platform}-${process.arch}`], { stdio: "inherit" });
} else {
  execFileSync("tar", ["-czf", archive, "-C", releaseDirectory, `${PRODUCT_NAME}-${process.platform}-${process.arch}`], { stdio: "inherit" });
}

const { size } = await stat(archive);
console.log(`${archive} (${(size / 1024 / 1024).toFixed(1)} MB)`);
