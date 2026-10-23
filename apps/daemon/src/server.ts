/**
 * The daemon's socket layer: an HTTP server for health checks and a
 * WebSocket endpoint that hands each connection to `RemoteHostServer`.
 *
 * All of the protocol rules — version negotiation, token authorization,
 * request correlation, event replay — live in `@rack/host`, which has no
 * socket dependency and is unit-tested with fakes. This file only adapts
 * `ws` sockets to the `HostConnection` interface and decides what the
 * process exposes over HTTP.
 *
 * `GET /health` is deliberately unauthenticated and deliberately empty of
 * anything sensitive. A VM supervisor needs to know whether the daemon
 * finished recovering before it reports the machine ready, and making that
 * probe require the pairing token would mean shipping the token to the
 * supervisor for no benefit. It reveals only liveness and protocol version.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import { PROTOCOL_VERSION, type ServerFrame } from "@rack/contracts/protocol";
import type { HostConnection, HostEndpoint } from "@rack/host";
import { RemoteHostServer, type EventStream } from "@rack/host";
import { WebSocketServer, type WebSocket } from "ws";

/** Path controllers connect to. Anything else gets 404. */
export const WEBSOCKET_PATH = "/rack";

export interface DaemonServerOptions {
  readonly endpoint: HostEndpoint;
  readonly events: EventStream;
  readonly machineId: string;
  readonly instanceId: string;
  readonly authorize: (token: string) => boolean;
  readonly onLog?: (message: string) => void;
}

export class DaemonServer {
  private readonly http: Server;
  private readonly sockets: WebSocketServer;
  private readonly remote: RemoteHostServer;

  constructor(options: DaemonServerOptions) {
    this.remote = new RemoteHostServer({
      endpoint: options.endpoint,
      events: options.events,
      machineId: options.machineId,
      instanceId: options.instanceId,
      authorize: options.authorize,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
    });

    this.http = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        const body = JSON.stringify({
          status: "ok",
          machineId: options.machineId,
          instanceId: options.instanceId,
          protocolVersion: PROTOCOL_VERSION,
          clients: this.remote.connectionCount,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found\n");
    });

    // `noServer` keeps the upgrade decision here, so a request to any other
    // path is refused before a WebSocket is ever created.
    this.sockets = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== WEBSOCKET_PATH) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }
      this.sockets.handleUpgrade(request, socket, head, (websocket) => {
        this.remote.accept(adapt(websocket, request));
      });
    });
  }

  /** Binds the listener. Resolves with the port actually bound. */
  listen(host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.http.off("error", onError);
        reject(error);
      };
      this.http.once("error", onError);
      this.http.listen(port, host, () => {
        this.http.off("error", onError);
        const address = this.http.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  get connectionCount(): number {
    return this.remote.connectionCount;
  }

  /** Closes controller connections, then the listener. */
  async close(reason: string): Promise<void> {
    this.remote.closeAll(reason);
    for (const socket of this.sockets.clients) socket.close(1001, reason);
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

/** Adapts one `ws` socket to the transport-independent `HostConnection`. */
function adapt(socket: WebSocket, request: IncomingMessage): HostConnection {
  return {
    remoteAddress: request.socket.remoteAddress ?? undefined,
    send(frame: ServerFrame) {
      // A peer that vanished mid-write is routine, not an error worth
      // propagating into the host's event fan-out.
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // Ignored for the same reason.
      }
    },
    close(reason: string) {
      // 1008 is "policy violation", which is what a refused handshake is;
      // `ws` requires the reason to fit in 123 bytes.
      socket.close(1008, reason.slice(0, 120));
    },
    onMessage(listener) {
      socket.on("message", (data: unknown) => {
        listener(String(data));
      });
    },
    onClose(listener) {
      socket.on("close", () => listener());
    },
  };
}
