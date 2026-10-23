# apps/web

The Rack interface in a browser, connected to a remote `rack-daemon` over a
WebSocket instead of the Electron preload bridge.

The interface itself is not reimplemented here. `@rack/ui` exposes
`mountApp({ root, host, params })`, and both this app and the desktop
renderer call it with a `HostClient`; the only difference is which transport
that client was built on. What this app adds is everything that exists
*because* the host is remote: choosing which daemon to talk to, proving it
may connect, and staying honest when the connection drops.

## Running it

```sh
npm run build:web               # from the repository root
npm run start:web               # build, then serve dist/ on 127.0.0.1:5173
```

`scripts/serve-web.ts` is a development static server. In production `dist/`
is a folder of static files and belongs behind whatever already terminates
TLS — see "Transport security" below.

## Pairing

On first load the app asks for a daemon address and a pairing token (read it
on that machine with `rack-daemon --print-token`). The interface is mounted
only after the daemon has accepted the token; showing a full workspace and
then discovering the token was refused would leave the user with an empty
screen and no explanation.

Two failure modes are kept distinct, because conflating them costs the user
something real:

- **Refused** (bad token, unsupported protocol version) is final. The token
  is forgotten and pairing is asked for again, with the daemon's reason.
- **Unreachable** (sleeping laptop, dropped network) is not. The token is
  kept and prefilled, and the user is offered a retry. Discarding a
  perfectly good token because a VPS was rebooting would be its own outage.

## Where the token is stored

The pairing token is the only thing standing between a visitor and a machine
that runs commands, so:

- it is kept in `sessionStorage` by default, scoped to the tab and cleared
  when the tab closes;
- `localStorage` is opt-in, behind an explicit "remember on this device"
  checkbox, because retyping a 43-character token every session is the kind
  of friction that pushes people toward weaker credentials on machines where
  remembering it is fine.

The daemon address and the client identifier are not secrets and are always
persisted, so only the token has to be re-entered.

## Transport security

`normalizeUrl` accepts `http`/`https` (which is what people paste) and
rewrites them to `ws`/`wss`, but refuses a plaintext `ws://` to anything
other than loopback: the pairing token crosses that wire. Use `wss://` for
any remote daemon, or reach a loopback-bound daemon through the tsnet
sidecar.

The page keeps the desktop app's strict Content Security Policy, with one
widening that running in a browser forces: `connect-src ws: wss:`, because
the daemon address is chosen by the user at pairing time and cannot be
listed in advance. Every other kind of outbound request is still forbidden.

## What is not available here

Folder pickers, "open in editor", revealing a path in the file manager and
the shared browser view are operations of the machine the *window* runs on,
performed by Electron main. A daemon has no windows, so the WebSocket
transport carries no shell and those calls raise `feature_unavailable` — the
same error the host already returns for a feature that was not assembled,
so the interface handles it through an existing path rather than a new
failure mode.

## Connection state

Once mounted, a dropped link shows a banner rather than tearing the
interface down: commands are queued and the event stream resumes, so the
right response to a blip is to say so and keep the user's context. A resume
the daemon could not satisfy (`truncated`) is called out separately, because
unlike a short blip it is not self-correcting and the screen may be stale.
