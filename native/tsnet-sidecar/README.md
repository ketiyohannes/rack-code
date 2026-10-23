# native/tsnet-sidecar

A small Go program that puts a local Rack daemon on a tailnet.

It joins the tailnet as its own userspace node using
[`tsnet`](https://pkg.go.dev/tailscale.com/tsnet) and forwards everything that
arrives on that node's port to the daemon's HTTP/WebSocket listener on
loopback. Controllers (desktop, web, mobile) on other devices in the same
tailnet reach the daemon by its MagicDNS name. No port forwarding, no inbound
firewall rule, no NAT traversal work and no relay server are involved, and the
sidecar needs neither root nor a TUN device: the node's network stack is
entirely in this process.

This is one of the two connectivity options in Rack's architecture. The other
is a relay server (see `apps/cloud`). They are alternatives, not layers: a
daemon reachable over a tailnet does not need the relay.

```text
controller device                         daemon machine
+-----------------+   WireGuard, tailnet  +---------------------------------+
| Rack controller | --------------------> | tsnet-sidecar  :80              |
+-----------------+   MagicDNS name       |        |                        |
                                          |        | plain HTTP, loopback   |
                                          |        v                        |
                                          | rack daemon  127.0.0.1:<port>   |
                                          +---------------------------------+
```

## Status and what has actually been verified

The program is complete and buildable. Within this repository the following
was run and passes: `go vet ./...`, `go build ./...`, `go test ./...` and
`go test -race ./...`.

What has **not** been verified, because it cannot be from here:

- It has never been run against a real tailnet. That needs a Tailscale (or
  Headscale) account and an auth key.
- It has never forwarded to a real Rack daemon. `apps/daemon` does not exist
  yet, so the daemon's listen port and URL layout are not fixed. The tests
  forward to ordinary `httptest` servers instead, including a real RFC 6455
  WebSocket handshake with bidirectional traffic after the upgrade.

The pieces that can be tested without a tailnet were deliberately put in
`internal/` behind interfaces so that they are tested: configuration parsing
and validation, credential handling, the forwarding handler, and the complete
start/serve/shutdown sequence (over a loopback listener, via a fake tailnet).
`internal/tailnet` is the only package that imports `tailscale.com`, and it is
thin on purpose, because it is the part no test here can cover.

## Layout

| Path | Responsibility |
| --- | --- |
| `cmd/tsnet-sidecar/main.go` | Process concerns only: configuration, logging, signals, exit codes. |
| `internal/config` | Flags, environment variables, validation, and the `Secret` type that keeps the auth key out of logs. |
| `internal/proxy` | The forwarding handler: upgrades, streaming, X-Forwarded-*, tailnet identity headers. Knows nothing about Tailscale. |
| `internal/sidecar` | Lifetime: join, listen, serve, drain, close. Depends on a `Tailnet` interface, not on `tsnet`. |
| `internal/tailnet` | The only Tailscale-specific code: adapts `tsnet.Server` to that interface. |

## Build and test

```sh
cd native/tsnet-sidecar
go test ./...                       # unit tests, no network and no tailnet needed
go build -o tsnet-sidecar ./cmd/tsnet-sidecar
```

This is a standalone Go module with its own `go.mod`. It is **not** an npm
workspace (the root `package.json` lists only `packages/*` and `apps/*`), so
`npm install` never sees it and the repository's TypeScript tooling never tries
to build it.

`go.mod` and `go.sum` are committed with `tailscale.com v1.90.6` pinned and
tidied. `go mod tidy` needs network access to `proxy.golang.org` for the
Tailscale dependency tree; it was run successfully when this module was added.

Cross-compiling for the VM images in `infra/images` works because `tsnet` is
pure Go:

```sh
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o tsnet-sidecar ./cmd/tsnet-sidecar
```

## Configuration

Every option is available as a flag and as an environment variable; a flag
wins over the environment. The environment form exists because the usual home
of this process is a systemd unit with an `EnvironmentFile`.

| Flag | Environment variable | Default | Meaning |
| --- | --- | --- | --- |
| `-hostname` | `TSNET_SIDECAR_HOSTNAME` | *required* | Tailnet node name. The daemon becomes reachable as `<hostname>.<tailnet>.ts.net`. |
| `-state-dir` | `TSNET_SIDECAR_STATE_DIR` | *required* | Absolute directory holding the node identity (`tailscaled.state`). Must be persistent; see below. |
| `-target` | `TSNET_SIDECAR_TARGET` | *required* | `host:port` of the daemon's listener. |
| `-allow-remote-target` | `TSNET_SIDECAR_ALLOW_REMOTE_TARGET` | `false` | Permit a non-loopback target. |
| `-listen-port` | `TSNET_SIDECAR_LISTEN_PORT` | `80` | Port to listen on **inside the tailnet**. No port is bound on the host's own interfaces. |
| `-tls` | `TSNET_SIDECAR_TLS` | `false` | Serve HTTPS with a Tailscale-issued MagicDNS certificate. |
| `-control-url` | `TSNET_SIDECAR_CONTROL_URL` | Tailscale's | Coordination server, for example a self-hosted Headscale. |
| `-ephemeral` | `TSNET_SIDECAR_EPHEMERAL` | `false` | Register an ephemeral node, removed by the control plane shortly after it disconnects. |
| `-tags` | `TSNET_SIDECAR_TAGS` | none | Comma-separated ACL tags (`tag:rack-daemon`) to advertise at registration. |
| `-shutdown-timeout` | `TSNET_SIDECAR_SHUTDOWN_TIMEOUT` | `20s` | Budget for draining in-flight requests on SIGINT/SIGTERM. |
| `-identity-headers` | `TSNET_SIDECAR_IDENTITY_HEADERS` | `true` | Forward the authenticated tailnet peer identity to the daemon. |
| `-log-level` | `TSNET_SIDECAR_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `-log-format` | `TSNET_SIDECAR_LOG_FORMAT` | `json` | `json` or `text`. Logs go to stderr. |

`-hostname`, `-state-dir` and `-target` have no defaults on purpose. Guessing a
hostname risks colliding with another node, guessing a state directory risks
silently losing the node identity on restart, and guessing a daemon port would
forward tailnet traffic to whatever happens to be listening there. The daemon's
port is owned by `apps/daemon` and is not fixed yet.

### The auth key

The tailnet auth key is read **only** from the environment, in this order:

1. `TSNET_SIDECAR_AUTHKEY` -- the key itself.
2. `TSNET_SIDECAR_AUTHKEY_FILE` -- a path to read it from, which keeps the key
   out of the process environment entirely. This is what systemd's
   `LoadCredential=` and the config disk in `infra/images` use.
3. `TS_AUTHKEY` -- Tailscale's conventional variable name, accepted so an
   operator does not have to duplicate an existing export.

There is deliberately no flag: flags are visible in `ps` output and land in
shell history. A unit test asserts that passing `-authkey` fails.

The key is held in a `config.Secret`, whose `String`, `GoString` and
`slog.LogValue` methods all return `[redacted]`; reading the real value needs
an explicit `Expose()` call, which is easy to grep for. The startup log line
reports only `auth_key_supplied=true|false`. As a second line of defence, every
log line produced by the Tailscale library passes through a scrubber that
removes the configured key and anything shaped like `tskey-...`.

The key is only needed the first time a node registers. Afterwards the identity
lives in `-state-dir`. **If that directory is not persistent, the node
re-registers on every start** and accumulates duplicate machines in the admin
console. The directory is created with mode `0700` because its contents
authenticate the machine to the tailnet.

If no key is supplied *and* the state directory holds no identity, the sidecar
refuses to start. It does not fall back to Tailscale's interactive login,
because for an unattended service, printing a URL and waiting forever is
indistinguishable from a hang.

## How forwarding works

The handler chain is small and each step is there for a reason.

**WebSocket upgrades.** The daemon's transport is a WebSocket, so upgrades are
the important case rather than an afterthought. Forwarding is done by
`net/http/httputil.ReverseProxy`, which handles protocol switching correctly:
it strips hop-by-hop headers but re-adds `Connection: Upgrade` and the
`Upgrade` token when the inbound request asks for a switch, and when the daemon
answers `101 Switching Protocols` it hijacks both connections and copies bytes
in both directions until either side closes. The module therefore needs no
WebSocket library and does not re-implement the handshake; `Sec-WebSocket-Key`
and the rest are ordinary headers that pass through unchanged. The test
`TestForwardsWebSocketUpgrade` performs a real handshake through the handler
and exchanges data over the upgraded connection afterwards.

Two settings exist to keep that path working and are called out in the code:

- The outbound transport sets `ForceAttemptHTTP2: false`. HTTP/2 has no
  equivalent of the RFC 6455 `Upgrade` mechanism, so a transport that
  negotiated h2c with the daemon would break every handshake.
- The inbound server sets only `ReadHeaderTimeout` and `IdleTimeout`.
  `ReadTimeout`/`WriteTimeout` apply to the whole request and response, so any
  value would eventually sever a healthy WebSocket session or a long-running
  event stream.

**Streaming.** `FlushInterval` is `-1`, so each write is flushed immediately.
Run events stream from the daemon as they happen; buffering here would turn
into visible latency in the controller.

**Headers.** `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` are
set from the inbound request, overwriting anything the peer sent. Note that the
`Host` header the daemon sees is the loopback target address, not the name the
controller used; **the daemon must read `X-Forwarded-Host` for any origin or
host check.**

**Tailnet identity.** With `-identity-headers` (the default), each forwarded
request carries the authenticated peer:

| Header | Value |
| --- | --- |
| `Rack-Tailnet-User` | Owning user's login, for example `alice@example.com`. |
| `Rack-Tailnet-Node` | Peer's MagicDNS name. |
| `Rack-Tailnet-Tags` | Peer's ACL tags, comma-separated. |

These three headers are **always stripped from the inbound request first**, so
a peer cannot assert them itself, and they are only set from a successful
Tailscale `WhoIs` lookup. If the lookup fails the request is answered with
`502` rather than forwarded without identity: a daemon that was told to trust
these headers must not silently receive an anonymous request.

## Shutdown

`SIGINT` or `SIGTERM` stops accepting new connections and drains in-flight
requests within `-shutdown-timeout`. A second signal exits immediately.

One caveat is worth stating plainly: Go's `http.Server.Shutdown` does not track
hijacked connections, so an established WebSocket session is not drained by it.
When the drain budget expires the server is closed and the tailnet node is torn
down, which closes the network stack those sessions live on. In other words,
long-lived controller connections are cut at the end of shutdown, not waited
for. The count of upgraded connections is logged when shutdown begins so this
is visible in the journal. Reconnection is the controller's responsibility;
replay of missed events belongs to the host transport, which already handles
it: `@rack/client`'s WebSocket transport reconnects with backoff and resumes
from its last applied event sequence (see `docs/architecture.md`, "Remote
protocol and transports").

## Operating notes

- **ACLs decide who can connect.** The sidecar authenticates nothing itself; it
  forwards whatever the tailnet delivers. Restrict access in the tailnet ACLs
  (for example, only the owner's devices or a specific tag may reach this
  node's port), and use the identity headers for finer decisions in the daemon.
- **Tags and key expiry.** A node owned by a user is subject to key expiry,
  which will eventually disconnect an unattended daemon. Register it with an
  ACL tag (`-tags tag:rack-daemon`) and the tailnet owns it instead.
- **Ephemeral nodes** suit disposable project VMs: the control plane removes
  them after they disconnect, so the admin console does not fill up with dead
  machines. They are wrong for a long-lived workstation daemon.
- **TLS.** Tailnet traffic is already encrypted by WireGuard, so plain HTTP is
  not an exposure. `-tls` exists for browsers: a page served over plain HTTP is
  not a secure context, so `apps/web` needs it. It requires HTTPS certificates
  to be enabled for the tailnet; if they are not, startup fails with the error
  from the certificate request rather than quietly falling back to plaintext.

## Intentionally not implemented

- **No authentication or authorization.** The tailnet decides reachability and
  the daemon decides permissions. Adding a second policy engine here would make
  it unclear which one is authoritative.
- **No Tailscale Funnel.** Funnel exposes a node to the public internet, which
  is exactly what this component exists to avoid. The relay path covers users
  who cannot use a tailnet.
- **No request routing, rewriting or multiple backends.** One sidecar forwards
  to one daemon. Routing belongs to the daemon.
- **No metrics endpoint or health check of its own.** Logs are the current
  interface; a health endpoint would have to be invented without knowing what
  `apps/vm-manager` wants to poll.
- **No daemon supervision.** If the daemon is down, requests get `502`.
  Restarting the daemon is the service manager's job; the unit files in
  `infra/images` wire that up.
