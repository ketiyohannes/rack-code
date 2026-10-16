/** Cross-capability behavior: standalone chats use normal execution without
 * fake Projects; planning and skill selection are enforced before native work.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AccountsService } from "../accounts/service.js";
import { InMemoryAccountStore } from "../accounts/in-memory-store.js";
import { SessionsService } from "../sessions/service.js";
import { InMemorySessionStore } from "../sessions/in-memory-store.js";
import { ProjectsService } from "../projects/service.js";
import { InMemoryProjectStore } from "../projects/in-memory-store.js";
import { ExecutionService } from "./service.js";
import { InMemoryExecutionStore } from "./in-memory-store.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import type { RuntimeAdapter, RuntimeRunInput, RuntimeEvent, RuntimeSkill } from "./types.js";

async function fixture() {
  const accounts = new AccountsService(new InMemoryAccountStore());
  await accounts.register({ id: "account", providerId: "test", identity: { providerAccountId: "native" }, credential: { id: "credential", providerId: "test", method: "test" }, runtimeContextId: "private-account", availability: "available" });
  const sessions = new SessionsService(new InMemorySessionStore(), { workspace: async (id) => `/chat-files/${id}` });
  const session = await sessions.create({ id: "chat" });
  const projects = new ProjectsService(new InMemoryProjectStore());
  const store = new InMemoryExecutionStore(); const registry = new RuntimeRegistry();
  const inputs: RuntimeRunInput[] = []; const decisions: string[] = [];
  const skill: RuntimeSkill = { id: "known", name: "writing", description: "Draft documents", path: "/installed/writing/SKILL.md", source: "Personal", enabled: true };
  const runtime: RuntimeAdapter = {
    runtimeId: "test", providerId: "test", describePermissionMode: (mode) => mode,
    capabilities: async () => ({ approvals: true, resume: true, fork: false, quotaReporting: false, browserTools: false, computerUse: false }),
    skills: async () => ({ skills: [skill], errors: [] }),
    async *startRun(input): AsyncIterable<RuntimeEvent> {
      inputs.push(input);
      if (input.interactionMode === "plan") {
        decisions.push(await input.requestApproval({ tool: "write", input: {} }));
        await assert.rejects(input.tools![0]!.execute({}), /Read only/);
      }
      yield { type: "native_session", nativeSessionId: "native-chat" };
      yield { type: "message_delta", text: input.interactionMode === "plan" ? "1. Inspect\n2. Implement\n3. Verify" : "Reply" };
      yield { type: "completed", result: "" };
    },
    resumeRun(input) { return this.startRun(input); }, cancel: async () => {},
  };
  registry.register(runtime);
  const execution = new ExecutionService(store, accounts, sessions, projects, registry, { tools: () => [{ name: "mutate", description: "mutation", inputSchema: {}, isMutation: () => true, execute: async () => "should not execute in Plan" }] });
  return { sessions, session, projects, store, inputs, decisions, skill, execution };
}
const request = { sessionId: "chat", providerId: "test", runtimeId: "test", prompt: "Help me write a document", permissionMode: "full_access" as const };

test("standalone chat persists history, receives its private cwd, and can attach a project", async () => {
  const f = await fixture();
  const run = await f.execution.start(request); await run.completed;
  assert.equal((await f.projects.listProjects()).length, 0);
  assert.equal((await f.execution.getRun(run.runId)).projectId, undefined);
  assert.equal(f.inputs[0]!.projectPath, "/chat-files/chat");
  assert.match(f.inputs[0]!.prompt, /general conversation/);
  const before = await f.sessions.get("chat");
  assert.equal(before.title, request.prompt); assert.equal(before.messages.length, 2);
  const project = await f.projects.createProject({ id: "project", path: "/project" });
  const attached = await f.sessions.attachProject("chat", project.id);
  assert.deepEqual(attached.messages, before.messages); assert.deepEqual(attached.continuations, []);
  const next = await f.execution.start({ ...request, projectId: project.id, prompt: "Continue" }); await next.completed;
  assert.equal(f.inputs[1]!.projectPath, "/project"); assert.match(f.inputs[1]!.prompt, /Help me write a document/);
  assert.equal((await f.projects.getProject(project.id)).activeWriterAttemptId, undefined);
});

test("Plan overrides full access, denies mutations, and requires a completed same-session plan to implement", async () => {
  const f = await fixture();
  const plan = await f.execution.start({ ...request, interactionMode: "plan", skillIds: ["known"] });
  const completed = await plan.completed;
  assert.equal(completed.permissionMode, "full_access"); assert.equal(f.inputs[0]!.permissionMode, "read_only");
  assert.deepEqual(f.decisions, ["deny"]); assert.deepEqual(f.inputs[0]!.skills, [f.skill]);
  assert.equal(completed.result, "1. Inspect\n2. Implement\n3. Verify");
  const other = await f.sessions.create({ id: "other" });
  await assert.rejects(f.execution.start({ ...request, sessionId: other.id, approvedPlanRunId: plan.runId }), /latest completed plan/);
  const implementation = await f.execution.start({ ...request, prompt: "", approvedPlanRunId: plan.runId }); await implementation.completed;
  assert.equal(f.inputs[1]!.permissionMode, "full_access"); assert.equal(f.inputs[1]!.interactionMode, "normal");
  assert.match(f.inputs[1]!.prompt, /explicitly approved plan:[\s\S]*1\. Inspect/);
  await assert.rejects(f.execution.start({ ...request, approvedPlanRunId: plan.runId }), /latest completed plan/);
});

test("unknown skills and mismatched project references never start a native turn", async () => {
  const f = await fixture();
  await assert.rejects(f.execution.start({ ...request, skillIds: ["forged-path"] }), /no longer available/);
  await assert.rejects(f.execution.start({ ...request, projectId: "other" }));
  assert.equal(f.inputs.length, 0); assert.equal((await f.store.listRuns("chat")).length, 0);
  // Synchronous reservation also protects headless clients before async validation.
  const first = f.execution.start(request);
  await assert.rejects(f.execution.start(request), /already running/);
  await (await first).completed;
});
