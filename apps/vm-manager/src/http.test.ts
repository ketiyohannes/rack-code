import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createVmManagerServer, parseMachineSpec } from "./http.js";
import { VmManagerService } from "./service.js";
import { EMPTY_MACHINE_DOCUMENT, MachineStore } from "./store.js";
import { MemoryDocument } from "./storage.js";
import { RequestValidationError } from "./errors.js";
import type { MachineDriver } from "./drivers/types.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

const driver: MachineDriver = {
  name: "test",
  capabilities: { implemented: true, simulated: true, liveSnapshots: false },
  create: async () => ({ directory: "/tmp/machine" }),
  start: async () => undefined,
  stop: async () => undefined,
  snapshot: async () => ({ handle: { disk: "/tmp/snapshot" }, sizeBytes: 4096 }),
  restore: async () => undefined,
  deleteSnapshot: async () => undefined,
  destroy: async () => undefined,
};

interface Client {
  call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; payload: Record<string, unknown> }>;
}

async function withServer(run: (client: Client) => Promise<void>): Promise<void> {
  const service = new VmManagerService(new MachineStore(new MemoryDocument(EMPTY_MACHINE_DOCUMENT)), driver);
  const server = createVmManagerServer({ service, token: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({
      async call(method, path, body, token = TOKEN) {
        const headers: Record<string, string> = {};
        if (token !== "") headers["authorization"] = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function machineOf(payload: Record<string, unknown>): Record<string, unknown> {
  return payload["machine"] as Record<string, unknown>;
}

test("machine specifications are validated, with defaults only for sizing", () => {
  const spec = parseMachineSpec({ name: "vm", image: "rack-base" });
  assert.deepEqual(spec, { name: "vm", image: "rack-base", vcpus: 2, memoryMiB: 2048, diskGiB: 20, labels: {} });
  assert.throws(() => parseMachineSpec({ image: "rack-base" }), RequestValidationError);
  assert.throws(() => parseMachineSpec({ name: "vm", image: "rack-base", vcpus: 0 }), RequestValidationError);
  assert.throws(() => parseMachineSpec({ name: "vm", image: "rack-base", memoryMiB: 1.5 }), RequestValidationError);
  // An unknown field means the caller and the service disagree about the
  // contract; accepting it silently would hide that.
  assert.throws(() => parseMachineSpec({ name: "vm", image: "rack-base", gpu: true }), RequestValidationError);
  assert.throws(() => parseMachineSpec({ name: "vm", image: "rack-base", labels: { owner: 7 } }), RequestValidationError);
});

test("health is public and names the driver; everything else needs the token", async () => {
  await withServer(async (client) => {
    const health = await client.call("GET", "/health", undefined, "");
    assert.equal(health.status, 200);
    assert.deepEqual(health.payload["driver"], { name: "test", implemented: true, simulated: true, liveSnapshots: false });

    assert.equal((await client.call("GET", "/v1/machines", undefined, "")).status, 401);
    assert.equal((await client.call("GET", "/v1/machines", undefined, "wrong-token")).status, 401);
    assert.equal((await client.call("GET", "/v1/machines", undefined, `${TOKEN}x`)).status, 401);
    assert.equal((await client.call("GET", "/v1/machines")).status, 200);
  });
});

test("the lifecycle is driven end to end over HTTP", async () => {
  await withServer(async (client) => {
    const created = await client.call("POST", "/v1/machines", { name: "project", image: "rack-base", labels: { accountId: "acc_1" } });
    assert.equal(created.status, 201);
    const id = machineOf(created.payload)["id"] as string;
    assert.equal(machineOf(created.payload)["state"], "running");

    const captured = await client.call("POST", `/v1/machines/${id}/snapshots`, { label: "before upgrade" });
    assert.equal(captured.status, 201);
    const snapshotId = (captured.payload["snapshot"] as Record<string, unknown>)["id"] as string;
    assert.equal(machineOf(captured.payload)["state"], "running");

    const listed = await client.call("GET", `/v1/machines/${id}/snapshots`);
    assert.equal((listed.payload["snapshots"] as unknown[]).length, 1);

    const restored = await client.call("POST", `/v1/machines/${id}/restore`, { snapshotId });
    assert.equal(restored.status, 200);
    assert.equal(machineOf(restored.payload)["state"], "stopped");

    assert.equal(machineOf((await client.call("POST", `/v1/machines/${id}/start`)).payload)["state"], "running");
    assert.equal(machineOf((await client.call("DELETE", `/v1/machines/${id}`)).payload)["state"], "destroyed");
  });
});

test("client mistakes are reported with their own codes", async () => {
  await withServer(async (client) => {
    const missing = await client.call("GET", "/v1/machines/does-not-exist");
    assert.equal(missing.status, 404);
    assert.equal((missing.payload["error"] as Record<string, unknown>)["code"], "not_found");

    const created = await client.call("POST", "/v1/machines", { name: "project", image: "rack-base" });
    const id = machineOf(created.payload)["id"] as string;

    const unknownSnapshot = await client.call("POST", `/v1/machines/${id}/restore`, { snapshotId: "missing" });
    assert.equal(unknownSnapshot.status, 404);

    const invalid = await client.call("POST", `/v1/machines/${id}/restore`, { snapshot: "missing" });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.payload["error"] as Record<string, unknown>)["code"], "invalid_request");

    await client.call("DELETE", `/v1/machines/${id}`);
    const destroyedTwice = await client.call("DELETE", `/v1/machines/${id}`);
    assert.equal(destroyedTwice.status, 409);
    assert.equal((destroyedTwice.payload["error"] as Record<string, unknown>)["code"], "invalid_transition");

    assert.equal((await client.call("GET", "/v1/unknown")).status, 404);
  });
});
