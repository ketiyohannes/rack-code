# apps/vm-manager (`@rack/vm-manager`)

A service that owns the lifetime of project microVMs. It runs on the bare VPS,
**outside** the machines it manages, and exposes a small authenticated HTTP API
used by `apps/cloud`.

It is a separate app rather than part of `apps/daemon` for one reason: a
restore destroys the running guest. The process driving it cannot be inside the
machine being restored, so machine lifetime lives here and agent execution
lives in the daemon. That separation is what makes safe shots — rolling a
project VM back to an earlier snapshot — possible at all.

The service depends on no `@rack/*` package and on nothing outside the Node
standard library. It never runs agents, never reads project data and holds no
provider credentials.

## Running it

```sh
RACK_VM_MANAGER_TOKEN=<at least 32 characters> npm start --workspace @rack/vm-manager
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `RACK_VM_MANAGER_TOKEN` | *(required)* | Shared bearer token for every `/v1` route |
| `RACK_VM_MANAGER_DRIVER` | `local` | `local`, `firecracker` or `cloud-hypervisor` |
| `RACK_VM_MANAGER_HOST` | `127.0.0.1` | Bind address; the default keeps machine destruction off the public internet |
| `RACK_VM_MANAGER_PORT` | `8791` | Listen port |
| `RACK_VM_MANAGER_STATE_DIR` | `./.rack-vm-manager` | Machine registry and, for the local driver, machine files |

Startup refuses a missing or short token and an unknown driver instead of
defaulting; it also reconciles machines whose operation was interrupted by a
restart, marking them `failed` with the reason.

## HTTP API

`GET /health` is unauthenticated and reports the driver and its capabilities.
Everything below requires `Authorization: Bearer <token>`.

| Route | Effect |
| --- | --- |
| `GET /v1/machines` | List machine records |
| `POST /v1/machines` | Create and boot a machine (`name`, `image`, optional `vcpus`, `memoryMiB`, `diskGiB`, `labels`) |
| `GET /v1/machines/:id` | One machine record |
| `POST /v1/machines/:id/start` | Boot a stopped machine |
| `POST /v1/machines/:id/stop` | Shut a running machine down |
| `GET /v1/machines/:id/snapshots` | List captures the service believes are restorable |
| `POST /v1/machines/:id/snapshots` | Capture a snapshot (optional `label`) |
| `POST /v1/machines/:id/restore` | Roll back to `snapshotId`; the machine is left stopped |
| `DELETE /v1/machines/:id/snapshots/:snapshotId` | Delete one capture |
| `DELETE /v1/machines/:id` | Destroy the machine and its snapshots |

Errors are `{ "error": { "code", "message", "details" } }` with codes
`invalid_request` (400), `unauthorized` (401), `not_found` (404),
`invalid_transition` (409), `driver_unsupported` (501) and `operation_failed`
(502).

## Lifecycle model

`src/lifecycle.ts` holds the rules as pure functions:

- An operation first moves the machine into a transient state (`creating`,
  `starting`, `stopping`, `snapshotting`, `restoring`, `destroying`) that no
  other operation accepts as a source. Because the store applies these rules
  under its write lock, a concurrent request is rejected with 409 instead of
  racing the first one.
- A driver error settles the machine as `failed` with the reason. The service
  never guesses the real state afterwards, because a hypervisor that reports an
  error may still have done part of the work. `start`, `stop`, `restore` and
  `destroy` all accept `failed` as a source, so recovery is a retry.
- A restore settles on `stopped` rather than resuming: rolling a disk back
  under a running kernel is not safe, so the caller issues an explicit `start`.
  A snapshot resumes the state it was captured from.
- Snapshot records are appended in the same store write that settles the
  machine, so a listed snapshot is always one the driver confirmed.

## Drivers

`src/drivers/types.ts` is the hypervisor port. Each driver declares whether it
is `implemented`, whether it is `simulated`, and whether its snapshots capture
guest memory; `/health` reports those flags so a development process cannot be
mistaken for one managing real machines.

- **`local`** (`src/drivers/local.ts`) is the working development and test
  driver. A machine is a directory with a `machine.json` and a `disk.img`; a
  snapshot is a copy of that file. Nothing boots and no guest ever runs, so it
  cannot host projects — but a restore really does replace the machine's
  current disk contents with the captured ones, which makes safe-shot behaviour
  testable without a VPS.
- **`firecracker` / `cloud-hypervisor`** (`src/drivers/hypervisor.ts`) is the
  seam for the real thing. It contains no hypervisor code and every operation
  fails with 501; the file documents, per operation, what an implementation
  must do and when it may return. Selecting it lets routing, authentication and
  the control plane be exercised without any call ever pretending to succeed.

## Not implemented

No hypervisor integration, networking, image building or storage management.
Authentication is one shared token for one caller, not a tenant-aware
authorization model: per-account access control belongs to `apps/cloud`, which
owns accounts. The machine registry is a single JSON document, adequate for one
host; several VPSes would need a shared store and an owner per machine.
