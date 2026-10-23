/** Branch publishing must consult live run ownership without blocking review reads. */
import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestsService, type PullRequestGateway } from "./index.js";

test("publishing rechecks live project writers while review reads remain available", async () => {
  let busy = true;
  const published: string[][] = [];
  const gateway = {
    publish: async (...args: string[]) => { published.push(args); },
    repositories: async () => [],
  } as unknown as PullRequestGateway;
  const service = new PullRequestsService(async () => ({ path: "/repo", busy }), gateway);
  await assert.rejects(service.publish("project", "origin", "main"), /active runs/);
  assert.deepEqual(published, []);
  assert.deepEqual(await service.repositories("project"), []);
  busy = false;
  await service.publish("project", "origin", "main");
  assert.deepEqual(published, [["/repo", "origin", "main"]]);
});
