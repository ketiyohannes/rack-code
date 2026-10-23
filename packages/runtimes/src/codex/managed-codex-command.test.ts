import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { bundledCodexCommand, managedCodexCommand } from "./managed-codex-command.js";

test("bundled native runtime resolves every supported platform and architecture", () => {
  for (const platform of ["darwin", "linux", "win32"]) for (const arch of ["x64", "arm64"]) {
    const cpu = arch === "x64" ? "x86_64" : "aarch64";
    const suffix = platform === "darwin" ? "apple-darwin" : platform === "linux" ? "unknown-linux-musl" : "pc-windows-msvc";
    const binary = join("/installed runtime", "vendor", `${cpu}-${suffix}`, "bin", platform === "win32" ? "codex.exe" : "codex");
    const seen: string[] = [];
    assert.equal(bundledCodexCommand({ platform, arch,
      resolve: (id) => { seen.push(id); return "/installed runtime/package.json"; }, isFile: (path) => path === binary,
    }), binary);
    assert.ok(seen.includes(`@openai/codex-${platform}-${arch}/package.json`));
  }
});

test("missing and unsupported runtimes fail clearly; explicit commands are preserved", () => {
  assert.throws(() => bundledCodexCommand({ platform: "freebsd", arch: "x64" }), /not supported/);
  assert.throws(() => bundledCodexCommand({ platform: "darwin", arch: "arm64", resolve: () => { throw new Error("missing"); } }), /bundled Codex runtime is missing/);
  assert.equal(managedCodexCommand(process.execPath), process.execPath);
});
