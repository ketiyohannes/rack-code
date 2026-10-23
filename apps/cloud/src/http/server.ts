/**
 * The HTTP surface: routing, authentication and error mapping.
 *
 * A small hand-written router over `node:http`, for the same reason as
 * `apps/vm-manager`: the surface is a few dozen routes and a framework would
 * add a dependency to a service that holds account credentials.
 *
 * Three things are deliberate here. Routes declare their authentication kind,
 * so adding a route without deciding who may call it is impossible. Handlers
 * receive the raw request body as well as the parsed one, because webhook
 * signatures cover exact bytes and re-serializing parsed JSON breaks them.
 * And unexpected errors become a 500 whose message is still returned —
 * clients of this service are the product's own apps, and a silent failure
 * costs more than the detail leaks.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { UnauthorizedError, UnsupportedError, describeError } from "../errors.js";
import { RequestValidationError } from "../errors.js";
import type { AccountRecord } from "../accounts/types.js";
import type { CloudApplication } from "../application.js";

/** Bodies are small JSON documents; anything larger is refused unread. */
const MAX_BODY_BYTES = 64 * 1024;

export type AuthKind = "public" | "account" | "relay-node";

export interface RequestContext {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: unknown;
  /** Exactly the bytes received, for signature verification. */
  readonly rawBody: string;
  readonly headers: IncomingMessage["headers"];
  /** Present on `account` routes, absent on the others. */
  readonly account: AccountRecord | undefined;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export interface Route {
  readonly method: "GET" | "POST" | "DELETE";
  /** `/v1/machines/:machineId/snapshots`; `:name` segments become params. */
  readonly path: string;
  readonly auth: AuthKind;
  readonly handle: (context: RequestContext) => Promise<RouteResult>;
}

export interface CloudServerOptions {
  readonly application: CloudApplication;
  readonly routes: readonly Route[];
  /**
   * Shared credential presented by relay nodes. When absent, relay-node routes
   * answer 501: a deployment without relay nodes should say so rather than
   * accept redemptions it cannot authenticate.
   */
  readonly relayNodeToken?: string;
  /** Reported by `/health` so operators can see what the process is wired to. */
  readonly describe?: () => Record<string, unknown>;
}

export function createCloudServer(options: CloudServerOptions): Server {
  const relayToken = options.relayNodeToken;

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const described = describeError(error);
      send(response, described.status, described.body);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://cloud.invalid");
    const segments = url.pathname.split("/").filter((segment) => segment !== "");
    const method = (request.method ?? "GET") as Route["method"];

    if (method === "GET" && segments.length === 1 && segments[0] === "health") {
      send(response, 200, { status: "ok", ...(options.describe?.() ?? {}) });
      return;
    }

    for (const route of options.routes) {
      const params = match(route, method, segments);
      if (params === undefined) continue;
      const rawBody = method === "GET" ? "" : await readBody(request);
      const account = await authenticate(route.auth, request);
      const result = await route.handle({
        params,
        query: url.searchParams,
        rawBody,
        body: parseBody(rawBody),
        headers: request.headers,
        account,
      });
      send(response, result.status, result.body);
      return;
    }
    send(response, 404, { error: { code: "not_found", message: `no route for ${method} ${url.pathname}`, details: {} } });
  }

  async function authenticate(kind: AuthKind, request: IncomingMessage): Promise<AccountRecord | undefined> {
    if (kind === "public") return undefined;
    const presented = bearer(request);
    if (kind === "relay-node") {
      if (relayToken === undefined) throw new UnsupportedError("relay redemption", "RACK_CLOUD_RELAY_NODE_TOKEN is not set");
      if (!constantTimeEquals(presented, relayToken)) throw new UnauthorizedError("invalid relay node credential");
      return undefined;
    }
    if (presented === "") throw new UnauthorizedError("an account token is required");
    return options.application.accounts.authenticate(presented);
  }
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function match(route: Route, method: string, segments: readonly string[]): Readonly<Record<string, string>> | undefined {
  const expected = route.path.split("/").filter((segment) => segment !== "");
  if (route.method !== method || expected.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, part] of expected.entries()) {
    const actual = segments[index];
    if (actual === undefined) return undefined;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(actual);
    else if (part !== actual) return undefined;
  }
  return params;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new RequestValidationError("", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(rawBody: string): unknown {
  const text = rawBody.trim();
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestValidationError("", "expected a JSON body");
  }
}

/** Path parameters are present by construction; this keeps the type honest. */
export function pathParam(context: RequestContext, name: string): string {
  const value = context.params[name];
  if (value === undefined) throw new RequestValidationError(name, "missing path parameter");
  return value;
}

/** Account routes always resolve an account before the handler runs. */
export function requireAccount(context: RequestContext): AccountRecord {
  if (context.account === undefined) throw new UnauthorizedError("an account token is required");
  return context.account;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}
