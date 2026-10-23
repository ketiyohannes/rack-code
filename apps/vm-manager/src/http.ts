/**
 * The HTTP surface.
 *
 * A small hand-written router over `node:http`. The service has one client
 * (the cloud control plane) and a handful of routes, so a framework would add
 * a dependency and a supply-chain surface for no benefit on a machine that
 * holds hypervisor privileges.
 *
 * Authentication is a single shared bearer token compared in constant time.
 * That is adequate because the service listens on a private interface and has
 * exactly one caller; it is not an authorization model, and per-tenant access
 * control belongs to the control plane that owns accounts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { RequestValidationError, UnauthorizedError, describeError } from "./errors.js";
import { asRecord, optionalInteger, optionalLabels, optionalText, rejectUnknownKeys, requiredText } from "./validation.js";
import type { VmManagerService } from "./service.js";
import type { MachineSpec } from "./types.js";

/** Bodies are small JSON documents; anything larger is refused unread. */
const MAX_BODY_BYTES = 64 * 1024;

interface RouteMatch {
  readonly params: Readonly<Record<string, string>>;
}

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handle: (match: RouteMatch, body: unknown) => Promise<{ status: number; body: unknown }>;
}

export function parseMachineSpec(body: unknown): MachineSpec {
  const record = asRecord(body);
  rejectUnknownKeys(record, ["name", "vcpus", "memoryMiB", "diskGiB", "image", "labels"]);
  return {
    name: requiredText(record, "name", 64),
    image: requiredText(record, "image", 256),
    vcpus: optionalInteger(record, "vcpus", 1, 64, 2),
    memoryMiB: optionalInteger(record, "memoryMiB", 256, 512 * 1024, 2048),
    diskGiB: optionalInteger(record, "diskGiB", 1, 4096, 20),
    labels: optionalLabels(record, "labels"),
  };
}

export function createVmManagerServer(options: { readonly service: VmManagerService; readonly token: string }): Server {
  const { service, token } = options;
  const expected = Buffer.from(token, "utf8");

  const routes: readonly Route[] = [
    {
      method: "GET",
      segments: ["v1", "machines"],
      handle: async () => ({ status: 200, body: { machines: await service.list() } }),
    },
    {
      method: "POST",
      segments: ["v1", "machines"],
      handle: async (_match, body) => ({ status: 201, body: { machine: await service.create(parseMachineSpec(body)) } }),
    },
    {
      method: "GET",
      segments: ["v1", "machines", ":machineId"],
      handle: async ({ params }) => ({ status: 200, body: { machine: await service.get(pathParam(params, "machineId")) } }),
    },
    {
      method: "DELETE",
      segments: ["v1", "machines", ":machineId"],
      handle: async ({ params }) => ({ status: 200, body: { machine: await service.destroy(pathParam(params, "machineId")) } }),
    },
    {
      method: "POST",
      segments: ["v1", "machines", ":machineId", "start"],
      handle: async ({ params }) => ({ status: 200, body: { machine: await service.start(pathParam(params, "machineId")) } }),
    },
    {
      method: "POST",
      segments: ["v1", "machines", ":machineId", "stop"],
      handle: async ({ params }) => ({ status: 200, body: { machine: await service.stop(pathParam(params, "machineId")) } }),
    },
    {
      method: "GET",
      segments: ["v1", "machines", ":machineId", "snapshots"],
      handle: async ({ params }) => ({ status: 200, body: { snapshots: (await service.get(pathParam(params, "machineId"))).snapshots } }),
    },
    {
      method: "POST",
      segments: ["v1", "machines", ":machineId", "snapshots"],
      handle: async ({ params }, body) => {
        const record = asRecord(body ?? {});
        rejectUnknownKeys(record, ["label"]);
        const label = optionalText(record, "label", 128);
        const machine = await service.snapshot(pathParam(params, "machineId"), label);
        return { status: 201, body: { machine, snapshot: machine.snapshots[machine.snapshots.length - 1] } };
      },
    },
    {
      method: "DELETE",
      segments: ["v1", "machines", ":machineId", "snapshots", ":snapshotId"],
      handle: async ({ params }) => ({
        status: 200,
        body: { machine: await service.deleteSnapshot(pathParam(params, "machineId"), pathParam(params, "snapshotId")) },
      }),
    },
    {
      method: "POST",
      segments: ["v1", "machines", ":machineId", "restore"],
      handle: async ({ params }, body) => {
        const record = asRecord(body);
        rejectUnknownKeys(record, ["snapshotId"]);
        return { status: 200, body: { machine: await service.restore(pathParam(params, "machineId"), requiredText(record, "snapshotId", 64)) } };
      },
    },
  ];

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const { status, body } = describeError(error);
      send(response, status, body);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://vm-manager.invalid");
    const segments = url.pathname.split("/").filter((segment) => segment !== "");

    // Health is unauthenticated so a supervisor can check liveness without
    // holding the token. It reports no machine identities or labels.
    if (request.method === "GET" && segments.length === 1 && segments[0] === "health") {
      send(response, 200, {
        status: "ok",
        driver: { name: service.driverName, ...service.driverCapabilities },
        machines: (await service.list()).length,
      });
      return;
    }

    authenticate(request, expected);

    for (const route of routes) {
      const params = match(route, request.method ?? "GET", segments);
      if (params === undefined) continue;
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await readJsonBody(request);
      const result = await route.handle({ params }, body);
      send(response, result.status, result.body);
      return;
    }
    send(response, 404, { error: { code: "not_found", message: `no route for ${request.method ?? "GET"} ${url.pathname}`, details: {} } });
  }
}

function match(route: Route, method: string, segments: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (route.method !== method || route.segments.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, expected] of route.segments.entries()) {
    const actual = segments[index];
    if (actual === undefined) return undefined;
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return undefined;
  }
  return params;
}

/** Path parameters are present by construction; this keeps the type honest. */
function pathParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RequestValidationError(name, "missing path parameter");
  return value;
}

function authenticate(request: IncomingMessage, expected: Buffer): void {
  const header = request.headers.authorization ?? "";
  const presented = Buffer.from(header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "", "utf8");
  // Compare a fixed-length digest-free value: lengths must match first, and an
  // early return on length alone leaks only the token length, not its bytes.
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw new UnauthorizedError();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RequestValidationError("", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestValidationError("", "expected a JSON body");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}
