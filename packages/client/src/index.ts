/**
 * Public entry point of `@rack/client`: one typed client for host commands
 * and events, and the transports that carry it.
 *
 * A controller picks a transport and the rest of the user interface is
 * unaware of the difference: `createBridgeTransport` for the Electron
 * preload bridge, `createWebSocketTransport` for a remote daemon.
 */
export { createHostClient } from "./host-client.js";
export type { HostClient } from "./host-client.js";
export { createBridgeTransport } from "./bridge-transport.js";
export { createWebSocketTransport } from "./websocket-transport.js";
export type { WebSocketTransportOptions, WebSocketLike } from "./websocket-transport.js";
export type { ClientTransport, ConnectionStatus, ShellOperations } from "./transport.js";
