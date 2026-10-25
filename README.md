# Rack

A coding agent harness. Rack runs provider agents (Codex, Claude) against
real projects and presents them in one interface.

Agents need a machine's filesystem, shell and git, so they run where the
code is. Rack splits that from the thing you look at: a **host** owns the
application and all in-flight runs, and a **controller** sends it commands
and receives its events. On the desktop both live on your laptop; with
`apps/daemon` the host can be a VPS or a project VM while the controller is
a browser or a phone. The command surface is identical either way.

## Layout

This is an npm-workspaces monorepo. **Packages** are shared libraries;
**apps** are things that run or ship.

```
packages/
  core/           domain rules and ports; depends on nothing
  features/       optional capabilities: timeline, browser, files, terminal, orchestration
  contracts/      commands, events, views, and the remote protocol (versioning, sequencing)
  runtimes/       Codex and Claude adapters, provider sign-in, the app tool server
  node-adapters/  Node implementations of the ports: JSON storage, git, worktrees, PTY
  host/           createApplication, HostApi, and the transports that serve them
  client/         HostClient over the preload bridge or a resumable WebSocket
  ui/             the framework-free interface, mountable on any client
apps/
  desktop/        the Electron app; runs its host locally
  daemon/         the same host without Electron, over WebSocket
  web/            the interface in a browser, connected to a daemon
  mobile/         a Capacitor shell around the web bundle
  vm-manager/     microVM lifecycle on a bare VPS: create, snapshot, restore
  cloud/          control plane: accounts, billing, provisioning, relay registry
native/tsnet-sidecar/   joins a tailnet and forwards to the local daemon
infra/images/           VM images with the daemon preinstalled
```

Dependencies point inward: `core` imports nothing, adapters and features
import `core`, `host` composes them, and apps compose `host`, `client` and
`ui`. `npm run check:boundaries` enforces this, so it is a build failure
rather than a review comment.

Package responsibilities and the full rule table are in
[docs/architecture.md](docs/architecture.md#repository-layout-and-package-boundaries).

## Commands

Run from the repository root:

```bash
npm install

npm run start              # build and launch the desktop app
npm run start:daemon       # run the headless host on this machine
npm run daemon:token       # print this machine's pairing token
npm run start:web          # build the browser controller and serve it

npm run typecheck          # tsc in every workspace
npm run check:boundaries   # enforce package dependency rules
npm test                   # unit and integration tests
npm run check              # all of the above plus the desktop and web builds

npm run build:desktop      # apps/desktop/dist/
npm run build:web          # apps/web/dist/
npm run build:mobile       # apps/mobile/www/ (then `npx cap sync` in apps/mobile)
npm run package:desktop    # packaged app in apps/desktop/release/
npm run archive:desktop    # that app as one downloadable archive
```

Every build writes inside its own app directory and is ignored by git.

## Connecting to a remote machine

Start the daemon on the machine that holds your code and read its pairing
token:

```bash
npm run start:daemon
npm run daemon:token
```

Then open the web controller and enter the daemon's address and that token.
The daemon binds to loopback by default; to reach it from elsewhere, put it
on your tailnet with `native/tsnet-sidecar` rather than exposing the port.
The pairing token is the only credential protecting a surface that can read
your files and run your processes.

See [docs/desktop.md](docs/desktop.md) for desktop details and native
fixture checks, and each app's README for its own notes.

## Releases

Pushing a `v*` tag builds Rack on one runner per platform and attaches the
archives to a **draft** GitHub release, which is then published by hand. The
tag has to match the version in `apps/desktop/package.json`; the workflow
refuses to build if it does not.

```bash
# bump apps/desktop/package.json, commit, then
git tag v1.1.0 && git push origin v1.1.0
```

One runner per platform is not a convenience: the Codex runtime and the
Claude Agent SDK ship as per-platform npm packages and `node-pty` compiles
on install, so nothing here cross-compiles. Builds are currently unsigned,
which is why the release notes carry the Gatekeeper and SmartScreen steps.
See [docs/architecture.md](docs/architecture.md#release-and-distribution).
