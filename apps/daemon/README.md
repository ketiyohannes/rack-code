# apps/daemon

`rack-daemon` is the Rack host without Electron. It composes the same
application the desktop app runs — accounts, sessions, projects, execution,
the Codex and Claude runtime adapters, JSON persistence — and serves it to
remote controllers over a WebSocket.

It is the piece that makes a machine *controllable*. Agents need a real
filesystem, a shell and git, so they have to run where the code is; the
daemon is what puts that machine on the other end of a socket.

## Running it

```sh
npm run start:daemon            # from the repository root
npm run daemon:token            # print the pairing token for this machine
```

```
rack-daemon [options]

  --host <address>          Interface to bind (default 127.0.0.1)
  --port <number>           Port to listen on (default 7420)
  --data-directory <path>   Application records (default ~/.thinking-and-code)
  --machine-id <id>         Identifier shown to controllers (default: hostname)
  --token-file <path>       Pairing token file (default <data-directory>/daemon/token)
  --replay-buffer <n>       Events retained for reconnecting clients (default 1024)
  --shutdown-timeout <s>    Seconds to wait for active runs on exit (default 10)
  --print-token             Print the pairing token and exit
```

`RACK_DAEMON_TOKEN` supplies the token instead of a file. Prefer it in VMs
and containers, where a file on disk would outlive the machine the secret
was issued for.

## Endpoints

| Path      | Purpose                                                        |
| --------- | -------------------------------------------------------------- |
| `/rack`   | WebSocket. Controllers connect here and speak the remote protocol. |
| `/health` | Unauthenticated liveness probe for a VM supervisor. Returns the machine ID, instance ID, protocol version and connected client count — never a secret. |

Any other path is refused, including WebSocket upgrades.

## Security

The daemon exposes a command surface that can read any file the user can
read and run any process the user can run. Two things follow:

**It binds to loopback by default.** The intended way to reach it from
another machine is the tsnet sidecar in `native/tsnet-sidecar`, which joins
your tailnet and forwards to the daemon, or a relay. Passing `--host` to
bind a public interface is possible, logs a warning, and leaves the pairing
token as the only thing protecting the machine.

**A pairing token is the only credential.** It is 256 bits of randomness,
generated on first start, stored with mode `0600`, and compared in constant
time. The daemon authenticates *devices*; authenticating *people* is
`apps/cloud`'s job. A controller that fails the handshake is disconnected
before it can send a command.

## Resumable sessions

Every host event is stamped with a monotonic sequence number and kept in a
bounded buffer. A controller records the highest sequence it applied and
asks to resume from it after a disconnect:

- the gap is still buffered → the daemon replays it and the controller keeps
  its state;
- the gap has been evicted, or the daemon has restarted since (a new
  `instanceId`) → the controller is told `truncated` and re-reads state with
  the ordinary read commands.

That fallback is always correct: host events are a freshness signal, not the
source of truth, so the replay buffer is a bandwidth optimization and never
a correctness requirement. See `packages/contracts/src/protocol.ts`.

## Shutdown

On `SIGINT` or `SIGTERM` the daemon asks the host to cancel active runs and
waits (bounded by `--shutdown-timeout`) for their terminal states to reach
disk before closing connections. A VM that is about to be snapshotted or
destroyed must not leave runs recorded as `running` that no process will
ever finish.

## What lives here and what does not

Every protocol rule — version negotiation, authorization, request
correlation, replay — lives in `@rack/host`'s `transport/` directory, which
has no socket dependency and is unit-tested with fakes. This app only adapts
`ws` sockets to that interface and owns configuration, tokens and process
lifetime.

The daemon composes the application *without* a browser driver: the shared
browser is an Electron view owned by desktop main, and a daemon has no
windows. Browser commands answer `feature_unavailable` rather than
pretending to succeed.
