/** Real owned subprocesses verify that closing transport breaks stalled RPCs and stops tools. */
import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcProcess, ProviderRequestTimeoutError } from "./json-rpc-process.js";

test("closing a stalled provider rejects requests and kills its owned process group", { timeout: 5000 }, async () => {
  const code = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
    console.log(JSON.stringify({method:'child',params:{pid:child.pid}}));
    process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000);`;
  const child = JsonRpcProcess.start(process.execPath, ["-e", code], { cwd: process.cwd(), environment: process.env });
  const message = await child.nextMessage();
  const pid = (message.value.params as { pid: number }).pid;
  const pending = assert.rejects(child.request("initialize", {}), /closed|exited/);
  const first = child.close(), second = child.close();
  assert.equal(first, second);
  await first; await pending;
  await assert.rejects(child.request("late", {}), /closed/);
  if (process.platform !== "win32") {
    const until = Date.now() + 1500;
    for (;;) {
      try { process.kill(pid, 0); } catch { break; }
      assert.ok(Date.now() < until, "owned child process must not survive transport close");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});

/** Main's bounded control requests must survive the process-group cleanup merge. */
test("provider request deadlines reject with the diagnostic error and finish owned cleanup", { timeout: 5000 }, async () => {
  const child = JsonRpcProcess.start(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)"], { cwd: process.cwd(), environment: process.env });
  try {
    await assert.rejects(child.request("initialize", {}, 50), (error: unknown) => error instanceof ProviderRequestTimeoutError && error.message.includes("initialize timed out"));
    await child.close();
    await assert.rejects(child.request("late", {}), /closed/);
  } finally { await child.close(); }
});
