import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveClaudeCommand } from "./claude-command.js";
import { CodexConnector } from "./codex-connector.js";
import { ClaudeConnector } from "./claude-connector.js";
import { diagnosticContext, diagnosticVersion, probeProcess, DiagnosticProcessError } from "./diagnostic-process.js";
import { JsonRpcProcess, ProviderRequestTimeoutError } from "../codex/json-rpc-process.js";

const context = { directory: process.cwd(), runtimeContextId: "account-context", environment: { TEST_CONTEXT: "isolated" } };

test("Codex checks handshake and account presence without login, refresh or a turn; closes on failure", async () => {
  for (const outcome of ["signed_in", "signed_out", "malformed", "error", "timeout"] as const) {
    const calls: Array<{ method: string; params: unknown; timeout?: number }> = [];
    let closed = 0;
    const connector = new CodexConnector({ command: process.execPath,
      probeProcess: async (_command, _args, cwd, env) => {
        assert.equal(cwd, context.directory); assert.equal(env["CODEX_HOME"], cwd);
        return { code: 0, stdout: "codex-cli 0.159.0\n" };
      },
      createProcess: (_command, _args, options) => {
        assert.equal(options.environment["TEST_CONTEXT"], "isolated");
        return {
          request: async (method: string, params: unknown, timeout?: number) => {
            calls.push({ method, params, ...(timeout === undefined ? {} : { timeout }) });
            if (method === "initialize") return {};
            if (outcome === "error") throw new Error("SECRET=do-not-display");
            if (outcome === "timeout") throw new ProviderRequestTimeoutError(method);
            return outcome === "malformed" ? {} : { account: outcome === "signed_in" ? { type: "chatgpt", secret: "do-not-display" } : null };
          }, notify: () => {}, close: async () => { closed++; },
        } as unknown as JsonRpcProcess;
      },
    });
    const result = await connector.diagnose(context);
    assert.equal(result.authentication, outcome === "signed_in" || outcome === "signed_out" ? outcome : "not_checked");
    assert.equal(result.status, outcome === "signed_in" ? "ready" : "failed");
    assert.deepEqual(calls.map((call) => call.method), ["initialize", "account/read"]);
    assert.deepEqual(calls[1]?.params, { refreshToken: false });
    assert.ok(calls.every((call) => call.timeout === 10_000));
    assert.equal(closed, 1);
    assert.ok(!JSON.stringify(result).includes("do-not-display"));
    if (outcome === "timeout") assert.match(result.message, /10 seconds/);
  }
});

test("installation checks isolate config, skip saved-account status and remove temporary files", async () => {
  let directory = "";
  const connector = new ClaudeConnector(process.execPath, async (_command, args, cwd, env) => {
    directory = cwd;
    assert.deepEqual(args, ["--version"]);
    assert.equal(env["CLAUDE_CONFIG_DIR"], cwd);
    assert.ok(existsSync(cwd));
    return { code: 0, stdout: "2.1.0 (Claude Code)\n" };
  });
  const result = await connector.diagnose();
  assert.equal(result.status, "ready"); assert.equal(result.authentication, "not_checked");
  assert.equal(result.version, "2.1.0"); assert.equal(existsSync(directory), false);
  await assert.rejects(diagnosticContext(undefined, async (scoped) => {
    directory = scoped.directory; throw new Error("expected failure");
  }), /expected failure/);
  assert.equal(existsSync(directory), false);
  if (process.platform === "win32") await diagnosticContext(undefined, async (scoped) => {
    const bin = join(scoped.directory, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude.exe"), "native-install-fixture");
    assert.equal(resolveClaudeCommand("claude", { Path: "C:\\missing", USERPROFILE: scoped.directory }), join(bin, "claude.exe"));
    assert.throws(() => resolveClaudeCommand("claude", {}), /native Claude Code/);
  });
});

test("Claude normalizes signed-out exit, invalid JSON and secret-bearing failures", async () => {
  for (const outcome of ["signed_in", "signed_out", "malformed", "error"] as const) {
    const connector = new ClaudeConnector(process.execPath, async (_command, args, cwd, env) => {
      assert.equal(cwd, context.directory);
      assert.equal(env["CLAUDE_CONFIG_DIR"], cwd);
      assert.equal(env["ANTHROPIC_API_KEY"], undefined);
      if (args[0] === "--version") return { code: 0, stdout: "2.1.0 (Claude Code)" };
      assert.deepEqual(args, ["auth", "status", "--json"]);
      if (outcome === "error") throw new Error("token=secret-value");
      return { code: outcome === "signed_out" ? 1 : 0,
        stdout: outcome === "malformed" ? "secret-value" : JSON.stringify({ loggedIn: outcome === "signed_in", token: "secret-value" }) };
    });
    const result = await connector.diagnose({ ...context, environment: { ANTHROPIC_API_KEY: "secret-value" } });
    assert.equal(result.authentication, outcome === "signed_in" || outcome === "signed_out" ? outcome : "not_checked");
    assert.ok(!JSON.stringify(result).includes("secret-value"));
  }
});

test("short process probes bound time and output; version parsing exposes only version", async () => {
  await assert.rejects(probeProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd(), process.env, 50),
    (error: unknown) => error instanceof DiagnosticProcessError && error.reason === "timeout");
  await assert.rejects(probeProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(70000))"], process.cwd(), process.env),
    (error: unknown) => error instanceof DiagnosticProcessError && error.reason === "output");
  const result = await probeProcess(process.execPath, ["-e", "process.stdout.write('ok');process.exitCode=3"], process.cwd(), process.env);
  assert.deepEqual(result, { stdout: "ok", code: 3 });
  assert.equal(diagnosticVersion("codex-cli 0.159.0\nsecret=value"), "0.159.0");
  assert.equal(diagnosticVersion("secret=value"), undefined);
});

test("RPC deadlines and explicit close settle all pending requests", async () => {
  const make = () => JsonRpcProcess.start(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { cwd: process.cwd(), environment: process.env });
  const child = make();
  const timed = assert.rejects(child.request("initialize", {}, 50), ProviderRequestTimeoutError);
  const pending = assert.rejects(child.request("other", {}), ProviderRequestTimeoutError);
  await Promise.all([timed, pending]);
  await assert.rejects(child.request("late", {}), /closed/);
  await child.close();
  const closing = make();
  const waiting = assert.rejects(closing.request("initialize", {}), /closed/);
  await closing.close(); await waiting;
});
