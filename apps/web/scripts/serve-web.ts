/**
 * Static file server for the built browser controller, for development.
 *
 * This is not a production deployment. `dist/` is a folder of static files;
 * in production it belongs behind whatever already terminates TLS, because
 * the pairing token crosses the wire and the controller refuses a plaintext
 * `ws://` to anything but loopback. This server exists so `npm start` in
 * `apps/web` does something useful without requiring that setup.
 *
 * Usage: tsx scripts/serve-web.ts [--port <number>] [--host <address>]
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(appRoot, "dist");

const argv = process.argv.slice(2);
const option = (flag: string, fallback: string): string => {
  const index = argv.indexOf(flag);
  return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const host = option("--host", "127.0.0.1");
const port = Number(option("--port", "5173"));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = createServer((request, response) => {
  void (async () => {
    const requested = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = requested === "/" ? "index.html" : normalize(requested).replace(/^[\\/]+/, "");
    const file = resolve(root, relative);
    // Path traversal would otherwise serve any file the process can read.
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end("Forbidden\n");
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": info.size,
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found\n");
    }
  })();
});

server.listen(port, host, () => {
  console.log(`[rack-web] serving ${root} at http://${host}:${String(port)}`);
});
