/**
 * Transports: how a composed host is reached.
 *
 * The host itself is transport-independent — `HostApi` validates and
 * dispatches commands and knows nothing about sockets. These modules supply
 * the two ways Rack serves it today:
 *
 * - `UtilityPortTransport` for the Electron utility process (`apps/desktop`),
 *   where both ends ship together and the link cannot be resumed;
 * - `RemoteHostServer` for remote controllers (`apps/daemon`), where version
 *   negotiation, token authorization and event replay all matter.
 *
 * `EventStream` is shared infrastructure for the remote case: it sequences
 * host events and retains a bounded tail so a reconnecting controller can be
 * caught up instead of re-reading everything.
 */
export { EventStream, DEFAULT_REPLAY_BUFFER } from "./event-stream.js";
export type { EventStreamOptions, ReplayResult } from "./event-stream.js";
export type { HostConnection, HostEndpoint } from "./connection.js";
export { RemoteHostServer } from "./remote-server.js";
export type { RemoteClient, RemoteHostServerOptions } from "./remote-server.js";
export { UtilityPortTransport, DEFAULT_BROWSER_TIMEOUT_MS } from "./utility-port.js";
export type { UtilityParentPort, UtilityPortTransportOptions } from "./utility-port.js";
