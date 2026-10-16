import assert from "node:assert/strict";
import test from "node:test";
import { win32 } from "node:path";
import { resolveCodexCommand } from "./codex-command.js";

test("Windows launch resolves native npm binaries without needing shell shims", () => {
  for (const arch of ["x64", "arm64"]) {
    const target = arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
    const prefix = "C:\\Users\\Test User\\AppData\\Roaming\\npm";
    for (const root of [
      `node_modules/@openai/codex/node_modules/@openai/codex-win32-${arch}`,
      `node_modules/@openai/codex-win32-${arch}`,
      "node_modules/@openai/codex",
    ]) {
      for (const folder of ["bin", "codex"]) {
        const binary = win32.join(prefix, root, "vendor", target, folder, "codex.exe");
        assert.equal(resolveCodexCommand(undefined, {
          platform: "win32", arch, environment: { Path: `"${prefix}"` }, isFile: (path) => path === binary,
        }), binary);
      }
    }
  }
});

test("desktop with stale PATH finds standard user npm install", () => {
  const binary = "C:\\User Data\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  assert.equal(resolveCodexCommand(undefined, {
    platform: "win32", arch: "x64", environment: { PATH: "C:\\Windows", AppData: "C:\\User Data" },
    isFile: (path) => path === binary,
  }), binary);
});

test("PATH order wins over fallback; relative paths and shell shims are ignored", () => {
  const available = new Set(["codex.exe", "C:\\first\\codex.cmd", "C:\\second\\codex.exe", "C:\\third\\codex.exe"]);
  assert.equal(resolveCodexCommand(undefined, {
    platform: "win32", environment: { PATH: ".;C:\\first;C:\\second;C:\\third" }, isFile: (path) => available.has(path),
  }), "C:\\second\\codex.exe");
});

test("missing Windows CLI reports actionable failure; overrides and other platforms are preserved", () => {
  assert.throws(() => resolveCodexCommand(undefined, {
    platform: "win32", environment: {}, isFile: () => false,
  }), /Install Codex CLI for Windows/);
  const noProbe = () => { throw new Error("Unexpected filesystem probe"); };
  assert.equal(resolveCodexCommand("D:\\custom\\codex.exe", { platform: "win32", isFile: noProbe }), "D:\\custom\\codex.exe");
  assert.equal(resolveCodexCommand(undefined, { platform: "linux", isFile: noProbe }), "codex");
});
