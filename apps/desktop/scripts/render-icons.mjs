/**
 * Renders `assets/icon.svg` into the platform icons that packaging uses:
 *   assets/icon.icns   macOS bundle icon (via `iconutil`, macOS only)
 *   assets/icon.ico    Windows executable icon (PNG-encoded entries)
 *   assets/icon.png    1024 px, Linux window icon and the development Dock icon
 *
 * The outputs are committed, so builds and the release workflow never run
 * this. Run it after editing the SVG, on a Mac:
 *   npx electron apps/desktop/scripts/render-icons.mjs
 *
 * Electron's Chromium rasterizes the SVG once per size (never by scaling a
 * large bitmap down), so small sizes stay sharp.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const svg = readFileSync(join(assets, "icon.svg"), "utf8");
const ICNS = [["16x16", 16], ["16x16@2x", 32], ["32x32", 32], ["32x32@2x", 64], ["128x128", 128],
  ["128x128@2x", 256], ["256x256", 256], ["256x256@2x", 512], ["512x512", 512], ["512x512@2x", 1024]];
const ICO = [16, 24, 32, 48, 64, 128, 256];

/** An ICO file whose entries are PNG images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("about:blank");
  const sizes = [...new Set([...ICNS.map(([, size]) => size), ...ICO])];
  const rendered = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
    await image.decode();
    const out = {};
    for (const size of ${JSON.stringify(sizes)}) {
      const canvas = document.createElement("canvas");
      canvas.width = size; canvas.height = size;
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, size, size);
      out[size] = canvas.toDataURL("image/png").split(",")[1];
    }
    return out;
  })()`);
  const png = (size) => Buffer.from(rendered[size], "base64");

  writeFileSync(join(assets, "icon.png"), png(1024));
  writeFileSync(join(assets, "icon.ico"), ico(ICO.map((size) => ({ size, png: png(size) }))));
  if (process.platform === "darwin") {
    const work = mkdtempSync(join(tmpdir(), "rack-icon-"));
    const iconset = join(work, "icon.iconset");
    execFileSync("mkdir", [iconset]);
    for (const [name, size] of ICNS) writeFileSync(join(iconset, `icon_${name}.png`), png(size));
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(assets, "icon.icns")]);
    rmSync(work, { recursive: true, force: true });
  } else {
    console.warn("Skipped icon.icns: iconutil is only available on macOS.");
  }
  console.log(`Wrote icons to ${assets}`);
  app.exit(0);
});
