import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createCloudApplication, createMemoryDocuments } from "../application.js";
import { createCloudServer } from "./server.js";
import { createRoutes } from "./routes.js";
import { createManualProvider, signManualWebhook } from "../billing/provider.js";
import type { VmMachine, VmManagerClient } from "../provisioning/vm-manager-client.js";

const WEBHOOK_SECRET = "webhook-secret-for-tests-0123456789";
const RELAY_SIGNING_SECRET = "relay-signing-secret-0123456789ab";
const RELAY_NODE_TOKEN = "relay-node-token-0123456789abcdef";

/** The same port `HttpVmManagerClient` implements, kept in memory. */
function fakeVmManager(): VmManagerClient {
  const machines = new Map<string, VmMachine>();
  let next = 0;
  return {
    async createMachine() {
      const machine: VmMachine = { id: `vm_${++next}`, state: "running", snapshots: [] };
      machines.set(machine.id, machine);
      return machine;
    },
    async getMachine(machineId) {
      return machines.get(machineId)!;
    },
    async snapshotMachine(machineId, label) {
      const machine = machines.get(machineId)!;
      const updated: VmMachine = {
        ...machine,
        snapshots: [...machine.snapshots, { id: `snap_${machine.snapshots.length + 1}`, label: label ?? "snapshot", capturedAt: "2026-10-23T10:00:00.000Z", sizeBytes: 2048 }],
      };
      machines.set(machineId, updated);
      return updated;
    },
    async restoreMachine(machineId) {
      const machine = machines.get(machineId)!;
      const restored: VmMachine = { ...machine, state: "stopped" };
      machines.set(machineId, restored);
      return restored;
    },
    async destroyMachine(machineId) {
      const machine = machines.get(machineId)!;
      machines.delete(machineId);
      return { ...machine, state: "destroyed" };
    },
  };
}

interface Response {
  readonly status: number;
  readonly payload: Record<string, unknown>;
}

interface Client {
  call(method: string, path: string, options?: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string }): Promise<Response>;
}

async function withServer(run: (client: Client) => Promise<void>): Promise<void> {
  const application = createCloudApplication({
    documents: createMemoryDocuments(),
    paymentProvider: createManualProvider({ webhookSecret: WEBHOOK_SECRET }),
    vmManager: fakeVmManager(),
    relaySigningSecret: RELAY_SIGNING_SECRET,
  });
  const server = createCloudServer({ application, routes: createRoutes(application), relayNodeToken: RELAY_NODE_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run({
      async call(method, path, options = {}) {
        const headers: Record<string, string> = { ...options.headers };
        if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
        const body = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
        if (body !== undefined) headers["content-type"] = "application/json";
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
        return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function signUp(client: Client, email: string): Promise<{ token: string; accountId: string }> {
  const created = await client.call("POST", "/v1/accounts", { body: { email, password: "correct horse battery", displayName: "Tester" } });
  assert.equal(created.status, 201);
  return { token: created.payload["token"] as string, accountId: (created.payload["account"] as Record<string, unknown>)["id"] as string };
}

function field(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  return payload[key] as Record<string, unknown>;
}

test("sign-up issues a token and a trial subscription in one call", async () => {
  await withServer(async (client) => {
    const created = await client.call("POST", "/v1/accounts", { body: { email: "Ada@Example.com ", password: "correct horse battery", displayName: "Ada" } });
    assert.equal(created.status, 201);
    assert.equal(field(created.payload, "account")["email"], "ada@example.com", "addresses are normalized before storage");
    assert.equal(field(created.payload, "subscription")["status"], "trialing");

    const me = await client.call("GET", "/v1/accounts/me", { token: created.payload["token"] as string });
    assert.equal(me.status, 200);
    assert.equal(field(me.payload, "entitlement")["mayProvision"], true);

    // The same address, differing only in case, is the same account.
    const duplicate = await client.call("POST", "/v1/accounts", { body: { email: "ada@example.com", password: "correct horse battery", displayName: "Ada" } });
    assert.equal(duplicate.status, 409);

    const weak = await client.call("POST", "/v1/accounts", { body: { email: "short@example.com", password: "too short", displayName: "Short" } });
    assert.equal(weak.status, 400);
  });
});

test("account routes refuse missing, wrong and revoked tokens", async () => {
  await withServer(async (client) => {
    const { token } = await signUp(client, "ada@example.com");
    assert.equal((await client.call("GET", "/v1/accounts/me")).status, 401);
    assert.equal((await client.call("GET", "/v1/accounts/me", { token: "rck_nonsense" })).status, 401);

    const issued = await client.call("POST", "/v1/accounts/tokens", { token, body: { name: "laptop" } });
    assert.equal(issued.status, 201);
    const second = issued.payload["token"] as string;
    assert.equal((await client.call("GET", "/v1/accounts/me", { token: second })).status, 200);

    await client.call("DELETE", `/v1/accounts/tokens/${issued.payload["tokenId"] as string}`, { token });
    assert.equal((await client.call("GET", "/v1/accounts/me", { token: second })).status, 401);
    assert.equal((await client.call("GET", "/v1/accounts/me", { token })).status, 200);
  });
});

test("billing moves only on a signed provider event", async () => {
  await withServer(async (client) => {
    const { token, accountId } = await signUp(client, "ada@example.com");
    assert.equal((await client.call("GET", "/v1/billing/plans")).status, 200, "the catalogue is public");

    const checkout = await client.call("POST", "/v1/billing/checkout", { token, body: { planId: "pro" } });
    assert.equal(checkout.status, 201);
    assert.equal(field(checkout.payload, "provider")["takesPayment"], false);
    assert.equal(field(checkout.payload, "subscription")["planId"], "free");

    const payload = JSON.stringify({ id: "evt_1", type: "payment_succeeded", accountId, planId: "pro" });
    const unsigned = await client.call("POST", "/v1/billing/webhook", { raw: payload, headers: { "x-rack-signature": "00".repeat(32) } });
    assert.equal(unsigned.status, 401);

    const applied = await client.call("POST", "/v1/billing/webhook", { raw: payload, headers: { "x-rack-signature": signManualWebhook(payload, WEBHOOK_SECRET) } });
    assert.equal(applied.status, 200);
    assert.equal(applied.payload["applied"], true);

    const subscription = await client.call("GET", "/v1/billing/subscription", { token });
    assert.equal(field(subscription.payload, "subscription")["planId"], "pro");
    assert.equal(field(subscription.payload, "entitlement")["machineLimit"], 5);
  });
});

test("a machine is provisioned, captured, restored and released by its owner alone", async () => {
  await withServer(async (client) => {
    const owner = await signUp(client, "ada@example.com");
    const stranger = await signUp(client, "alan@example.com");

    const created = await client.call("POST", "/v1/machines", { token: owner.token, body: { name: "project" } });
    assert.equal(created.status, 201);
    const machineId = field(created.payload, "assignment")["id"] as string;
    assert.equal(field(created.payload, "assignment")["state"], "active");

    assert.equal((await client.call("GET", `/v1/machines/${machineId}`, { token: stranger.token })).status, 404);
    assert.deepEqual((await client.call("GET", "/v1/machines", { token: stranger.token })).payload["machines"], []);

    const captured = await client.call("POST", `/v1/machines/${machineId}/snapshots`, { token: owner.token, body: { label: "before upgrade" } });
    assert.equal(captured.status, 201);
    const snapshots = field(captured.payload, "machine")["snapshots"] as Record<string, unknown>[];
    assert.equal(snapshots.length, 1);

    const restored = await client.call("POST", `/v1/machines/${machineId}/restore`, { token: owner.token, body: { snapshotId: snapshots[0]?.["id"] as string } });
    assert.equal(restored.status, 200);
    assert.equal(field(restored.payload, "machine")["state"], "stopped");

    // The free trial allows one machine.
    assert.equal((await client.call("POST", "/v1/machines", { token: owner.token, body: { name: "second" } })).status, 409);
    assert.equal((await client.call("DELETE", `/v1/machines/${machineId}`, { token: owner.token })).status, 200);
    assert.equal((await client.call("POST", "/v1/machines", { token: owner.token, body: { name: "second" } })).status, 201);
  });
});

test("a daemon registers, heartbeats with its own secret, and is found by its account", async () => {
  await withServer(async (client) => {
    const owner = await signUp(client, "ada@example.com");
    const stranger = await signUp(client, "alan@example.com");

    const registered = await client.call("POST", "/v1/registry/daemons", {
      token: owner.token,
      body: { name: "workstation", version: "1.0.0", endpoints: ["wss://relay.example/d/1"], publicKey: "key-abc" },
    });
    assert.equal(registered.status, 201);
    const daemonId = field(registered.payload, "daemon")["id"] as string;
    const secret = registered.payload["heartbeatSecret"] as string;

    const listed = await client.call("GET", "/v1/registry/daemons", { token: owner.token });
    assert.equal((listed.payload["daemons"] as unknown[]).length, 1);
    assert.deepEqual((await client.call("GET", "/v1/registry/daemons", { token: stranger.token })).payload["daemons"], []);

    assert.equal((await client.call("POST", `/v1/registry/daemons/${daemonId}/heartbeat`, { body: { secret: "wrong" } })).status, 401);
    const beat = await client.call("POST", `/v1/registry/daemons/${daemonId}/heartbeat`, { body: { secret, endpoints: ["wss://relay.example/d/2"] } });
    assert.equal(beat.status, 200);
    assert.deepEqual(field(beat.payload, "daemon")["endpoints"], ["wss://relay.example/d/2"]);
  });
});

test("relay tickets are issued to owners and redeemed once by a relay node", async () => {
  await withServer(async (client) => {
    const owner = await signUp(client, "ada@example.com");
    const stranger = await signUp(client, "alan@example.com");
    const registered = await client.call("POST", "/v1/registry/daemons", {
      token: owner.token,
      body: { name: "workstation", version: "1.0.0", endpoints: ["wss://relay.example/d/1"], publicKey: "key-abc" },
    });
    const daemonId = field(registered.payload, "daemon")["id"] as string;

    assert.equal((await client.call("POST", "/v1/relay/tickets", { token: stranger.token, body: { daemonId } })).status, 404);
    const issued = await client.call("POST", "/v1/relay/tickets", { token: owner.token, body: { daemonId } });
    assert.equal(issued.status, 201);
    const ticket = issued.payload["ticket"] as string;

    // Redemption is the relay node's call, not the client's: an account token
    // must not resolve a daemon's endpoints by replaying its own ticket.
    assert.equal((await client.call("POST", "/v1/relay/redeem", { token: owner.token, body: { ticket } })).status, 401);

    const redeemed = await client.call("POST", "/v1/relay/redeem", { token: RELAY_NODE_TOKEN, body: { ticket } });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.payload["daemonId"], daemonId);
    assert.deepEqual(redeemed.payload["endpoints"], ["wss://relay.example/d/1"]);

    const replayed = await client.call("POST", "/v1/relay/redeem", { token: RELAY_NODE_TOKEN, body: { ticket } });
    assert.equal(replayed.status, 401);
  });
});

test("malformed requests are refused with their own codes", async () => {
  await withServer(async (client) => {
    const { token } = await signUp(client, "ada@example.com");
    assert.equal((await client.call("GET", "/v1/nothing-here", { token })).status, 404);

    const unknownField = await client.call("POST", "/v1/machines", { token, body: { name: "project", gpu: true } });
    assert.equal(unknownField.status, 400);
    assert.equal(field(unknownField.payload, "error")["code"], "invalid_request");

    const notJson = await client.call("POST", "/v1/machines", { token, raw: "{not json" });
    assert.equal(notJson.status, 400);

    assert.equal((await client.call("POST", "/v1/billing/checkout", { token, body: { planId: "enterprise" } })).status, 404);
    assert.equal((await client.call("POST", "/v1/billing/webhook", { body: { id: "evt_1" } })).status, 401, "an unsigned webhook is refused before it is parsed");
  });
});

test("health reports what the process is wired to without a token", async () => {
  await withServer(async (client) => {
    const health = await client.call("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.payload["status"], "ok");
  });
});
