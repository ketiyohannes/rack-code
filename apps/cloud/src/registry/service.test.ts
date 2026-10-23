import assert from "node:assert/strict";
import test from "node:test";
import { RegistryService } from "./service.js";
import { EMPTY_REGISTRY_DOCUMENT, HEARTBEAT_TIMEOUT_MS, type RegistryDocument } from "./types.js";
import { MemoryDocument } from "../storage.js";
import { NotFoundError, UnauthorizedError } from "../errors.js";

const START = new Date("2026-10-23T10:00:00.000Z");

function registry(now: () => Date = () => START): { service: RegistryService; document: MemoryDocument<RegistryDocument> } {
  const document = new MemoryDocument<RegistryDocument>(EMPTY_REGISTRY_DOCUMENT);
  return { service: new RegistryService(document, now), document };
}

const REGISTRATION = { name: "workstation", version: "1.0.0", endpoints: ["wss://relay.example/d/1"], publicKey: "key-abc" };

test("a registration is readable by its own account and invisible to others", async () => {
  const { service } = registry();
  const { daemon } = await service.register("acc_1", REGISTRATION);
  assert.equal(daemon.status, "online");
  assert.deepEqual((await service.list("acc_1")).map((entry) => entry.id), [daemon.id]);
  assert.deepEqual(await service.list("acc_2"), []);
  // A leaked daemon ID resolves to nothing for another account.
  await assert.rejects(service.get("acc_2", daemon.id), NotFoundError);
  assert.equal((await service.get("acc_1", daemon.id)).publicKey, "key-abc");
});

test("the heartbeat secret is never published", async () => {
  const { service, document } = registry();
  const { daemon, secret } = await service.register("acc_1", REGISTRATION);
  assert.equal(JSON.stringify(daemon).includes(secret), false);
  assert.equal(JSON.stringify(await document.read()).includes(secret), false, "only a digest is stored");
});

test("liveness is computed from the last heartbeat, not stored", async () => {
  let now = START;
  const { service } = registry(() => now);
  const { daemon, secret } = await service.register("acc_1", REGISTRATION);

  now = new Date(START.getTime() + HEARTBEAT_TIMEOUT_MS + 1000);
  assert.equal((await service.get("acc_1", daemon.id)).status, "offline", "a machine that stopped reporting is not online");

  const beaten = await service.heartbeat(daemon.id, secret, { endpoints: ["wss://relay.example/d/2"], version: "1.1.0" });
  assert.equal(beaten.status, "online");
  assert.deepEqual(beaten.endpoints, ["wss://relay.example/d/2"], "a daemon reports its current address with each heartbeat");
  assert.equal(beaten.version, "1.1.0");
});

test("heartbeats require the daemon's own secret", async () => {
  const { service } = registry();
  const { daemon } = await service.register("acc_1", REGISTRATION);
  await assert.rejects(service.heartbeat(daemon.id, "dmn_wrong-secret"), UnauthorizedError);
  await assert.rejects(service.heartbeat("dmn_unknown", "dmn_wrong-secret"), UnauthorizedError);
});

test("re-registering under the same name keeps the identity and rotates the secret", async () => {
  const { service } = registry();
  const first = await service.register("acc_1", REGISTRATION);
  const second = await service.register("acc_1", { ...REGISTRATION, version: "2.0.0", endpoints: ["wss://relay.example/d/9"] });

  assert.equal(second.daemon.id, first.daemon.id, "a reinstalled daemon keeps the identity clients already hold");
  assert.equal(second.daemon.registeredAt, first.daemon.registeredAt);
  assert.equal((await service.list("acc_1")).length, 1);
  // A secret copied from the previous machine, for example out of a snapshot
  // that was restored elsewhere, stops working.
  await assert.rejects(service.heartbeat(first.daemon.id, first.secret), UnauthorizedError);
  assert.equal((await service.heartbeat(second.daemon.id, second.secret)).version, "2.0.0");
});

test("deregistration is scoped to the owner", async () => {
  const { service } = registry();
  const { daemon } = await service.register("acc_1", REGISTRATION);
  await assert.rejects(service.deregister("acc_2", daemon.id), NotFoundError);
  await service.deregister("acc_1", daemon.id);
  assert.deepEqual(await service.list("acc_1"), []);
});
