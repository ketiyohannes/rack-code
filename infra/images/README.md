# infra/images

Build definitions for the VM image that `apps/vm-manager` boots as a per-project
microVM, with the Rack daemon preinstalled.

One image serves every project VM. It contains software only: the daemon
bundle, a Node.js runtime, the tailnet sidecar and the units that start them.
Everything specific to a VM -- its pairing token, its tailnet identity, its
project data -- arrives at boot on two separate disks. That split is what makes
the rootfs disposable: upgrading the daemon means booting existing data disks
against a new rootfs, not migrating machines.

```text
            +-------------------------------------------------+
  vda  ---> | rootfs.ext4   this image, replaceable on upgrade |
  vdb  ---> | rack-config   per-VM, read-only, built per boot  |
  vdc  ---> | rack-data     per-project, persistent            |
            +-------------------------------------------------+
                                  |
                   systemd -> rack-preflight.service
                              rack-daemon.service
                              rack-tsnet-sidecar.service (optional)
```

## Status: what is and is not verified

The build definition is complete and reviewable. **Nothing here has been built
or booted**, and it could not be when it was written:

- `apps/daemon` does not exist yet. The image needs a built daemon bundle as an
  input; `scripts/build-rootfs.sh` refuses to run without one and says so.
- No Docker daemon was running on the machine where this was written, so
  `docker build` has never been executed against this Dockerfile. The shell
  scripts were checked with `bash -n`; that is a syntax check, not a run.
- No hypervisor was available, so no VM has been started from this image. Boot
  correctness (kernel options, virtio device naming, systemd reaching
  `multi-user.target`) is unverified.
- The tailnet sidecar inside the image has not been exercised against a real
  tailnet; see `native/tsnet-sidecar/README.md`. Its Go tests do pass.

What this does give you is a build that fails loudly rather than producing a
plausible-looking image: a missing daemon bundle fails the Docker `COPY`, a
missing entry point fails the build script's precondition check, an export that
lacks the expected files fails the conversion, and a VM booted without its
config or data disk fails `rack-preflight.service` before the daemon starts.

## Why a Dockerfile, and not Packer

Both were reasonable. This uses a Dockerfile plus a conversion step.

**The approach here.** `daemon/Dockerfile` describes the guest filesystem as a
container image; `scripts/build-rootfs.sh` exports it and `mke2fs -d` turns the
exported tree into an ext4 filesystem image. The conversion runs as root
*inside a container*, so the host needs no root, no loop device and no
hypervisor, and the build behaves the same on a developer's macOS laptop and in
Linux CI. Layer caching makes iteration fast, and the result is a single file
plus a tarball -- nothing stateful.

**The trade-off.** A Dockerfile cannot run the guest, so nothing can be
verified by booting during the build: no "wait for SSH, run a smoke test, then
snapshot" step. It also cannot install a bootloader or partition a disk, which
is fine here (a microVM boots an external kernel with `root=/dev/vda` and needs
neither) but would be a blocker for a general cloud image. Finally, the
packages come from Debian's repositories at build time; the image is
reproducible in structure but not bit-for-bit, because apt resolves to current
package versions.

**What Packer would have given.** A Packer template with the QEMU builder boots
a real VM, provisions it and verifies it, producing an artifact already known
to boot -- and it can emit AMIs, qcow2 and raw images from one template. The
cost is a hypervisor (KVM, or nested virtualization in CI), much slower
iteration, and a build that cannot run at all on a machine without it. Since
the first consumer is `apps/vm-manager` booting Firecracker microVMs from a raw
ext4 rootfs, that extra capability buys little today.

If image verification by boot becomes necessary, the honest migration is to
keep this Dockerfile as the definition of the filesystem and add a separate
boot-test step, rather than to re-describe the same filesystem in a second
language.

## Building

```sh
# Prerequisite: a daemon bundle built for linux, at apps/daemon/dist.
infra/images/scripts/build-rootfs.sh
```

Docker is the only requirement. Output goes to `infra/images/dist/rootfs.ext4`
(ignored by git).

| Variable | Default | Meaning |
| --- | --- | --- |
| `ARCH` | `amd64` | Target architecture. Building `amd64` on an Apple Silicon host works but is emulated and slow. |
| `DAEMON_DIST` | `apps/daemon/dist` | Daemon bundle directory, relative to the repository root. |
| `DAEMON_ENTRY` | `main.js` | File inside the bundle that `node` runs. |
| `ROOTFS_SIZE_MB` | `2048` | Size of the ext4 image. It holds software only; project data lives on the data disk. |
| `IMAGE_TAG` | `rack-daemon-rootfs:dev` | Docker tag for the intermediate image. |
| `OUT_DIR` | `infra/images/dist` | Where the artifacts are written. |
| `KEEP_TAR` | `0` | Keep the intermediate `rootfs.tar` for inspection. |

**The daemon bundle must be built for the image's platform.** Rack uses native
modules -- `node-pty` for terminals most obviously -- and a bundle produced on
macOS, or for arm64, will fail at runtime inside a linux/amd64 guest with a
module-loading error. Building the bundle is `apps/daemon`'s responsibility,
not this directory's.

## What goes into the image

| Path | Contents |
| --- | --- |
| `/opt/rack/daemon/` | The daemon bundle, copied from `DAEMON_DIST`. |
| `/usr/local/bin/node` | Node.js, taken from the official `node` image. Only the interpreter: no npm, no corepack, no headers. |
| `/usr/local/bin/tsnet-sidecar` | Built from `native/tsnet-sidecar` in the same Docker build. Static, CGO disabled. |
| `/usr/local/sbin/rack-preflight` | Boot-time validation of the contract below. |
| `/etc/systemd/system/*` | The mount units and services listed below. |
| `/usr/lib/sysusers.d/rack.conf` | The `rack` and `rack-tsnet` service accounts. |

Base packages are Debian's `systemd`, `dbus`, `ca-certificates`, `git`,
`openssh-client`, `iproute2`, `iputils-ping`, `procps`, `less`,
`systemd-timesyncd` and `tzdata` -- a CA bundle so the daemon can reach model
providers, repository tooling for agent work, and enough to diagnose a VM from
the serial console.

Two service accounts rather than one, deliberately: the daemon executes
agent-authored commands as `rack`, so anything readable by `rack` must be
assumed readable by an agent. The sidecar runs as `rack-tsnet` and keeps its
tailnet node key in a `0700` directory that `rack` cannot read.

## The contract with `apps/vm-manager`

This is the interface the guest expects. `apps/vm-manager` is not implemented
yet, so this is a **proposal from the image side**; the daemon's own
environment variable names belong to `apps/daemon` and will need to be
reconciled when it lands.

### Block devices

| Device | Filesystem label | Mount | Mode | Supplied by |
| --- | --- | --- | --- | --- |
| rootfs | `rack-root` | `/` | read-write | this directory |
| config disk | `rack-config` | `/run/rackconfig` | read-only, `nosuid,nodev,noexec` | vm-manager, per boot |
| data disk | `rack-data` | `/var/lib/rack` | read-write | vm-manager, per project |

The mount units match on filesystem label, not device node, so the guest does
not depend on the order in which the hypervisor attached the disks.

### Config disk contents

| File | Required | Purpose |
| --- | --- | --- |
| `daemon.env` | yes | `KEY=VALUE` lines read by `rack-daemon.service` as an `EnvironmentFile`. Per-VM identity only: `RACK_MACHINE_ID` (the name controllers see; defaults to the guest hostname) and `RACK_DAEMON_PORT` (defaults to 7420). |
| `pairing.token` | yes | The token a controller must present to pair with this daemon. Mode must not be world-readable; `root:rack` `0440` is the intended ownership. |
| `tsnet.env` | no | `KEY=VALUE` lines for the sidecar. Its presence is what starts the sidecar at all. At minimum `TSNET_SIDECAR_HOSTNAME`; the target defaults to the daemon's loopback listener and only needs setting when `RACK_DAEMON_PORT` moved it. |
| `tsnet.authkey` | with `tsnet.env` | The tailnet auth key. `root:rack-tsnet` `0440`. |

Build this filesystem fresh per VM (an ext4 image of a few MiB is enough) and
attach it read-only.

Be aware of what the pairing token's placement means: the daemon runs as `rack`
and must read the token, so **anything running as the daemon's user, including
agent processes, can read it**. It must therefore be scoped to one VM and be
revocable by the control plane. The tailnet auth key is group-readable by
`rack-tsnet` only, so it is not exposed the same way.

Settings that describe the *image's own layout* are not environment variables
at all: `rack-daemon.service` passes `--data-directory /var/lib/rack/data` and
`--token-file /run/rackconfig/pairing.token` as arguments on its `ExecStart`
line, which a config disk cannot rewrite. A VM therefore cannot move the data
directory off the persistent disk or redirect the daemon to a different token.
The sidecar's `TSNET_SIDECAR_STATE_DIR` and `TSNET_SIDECAR_AUTHKEY_FILE` are
set *after* its `EnvironmentFile` line for the same reason — later assignments
win in systemd.

`--host` is deliberately left at the daemon's default of loopback. Binding a
routable interface would leave the pairing token as the only thing protecting
a machine that runs arbitrary code; the sidecar is how this image expects to
be reached from outside the guest.

### Data disk layout

| Path | Owner | Contents |
| --- | --- | --- |
| `/var/lib/rack/data` | `rack` | The daemon's data directory: sessions, execution journal, attachments. Created on first boot. |
| `/var/lib/rack/tsnet` | `rack-tsnet`, `0700` | The tailnet node identity. If this is lost the node re-registers and appears as a new machine. |

Everything else under `/var/lib/rack` is the daemon's to organize, including
project checkouts. A VM's first boot gets an empty filesystem; the units create
what they need.

### Boot and shutdown

- **Kernel command line.** `root=/dev/vda rw init=/sbin/init console=ttyS0`.
  The kernel is supplied by vm-manager and must have virtio-blk, virtio-net and
  ext4 built in (a microVM has no initramfs to load modules from).
- **Default target.** `multi-user.target`.
- **Startup order.** Both disks mount, then `rack-preflight.service` validates
  the contract, then `rack-daemon.service` starts, then
  `rack-tsnet-sidecar.service` if `tsnet.env` is present.
- **Failure behavior.** A missing disk or a missing required file fails
  preflight, which blocks both services. The message goes to the serial console
  as well as the journal.
- **Graceful shutdown.** Firecracker's only graceful stop is `SendCtrlAltDel`,
  so the image maps `ctrl-alt-del.target` to `poweroff.target`. The daemon's
  unit allows 45 seconds to stop, matching the bounded shutdown described in
  `docs/architecture.md`: it cancels runs and records their outcome rather than
  being killed mid-run.
- **Machine identity.** `/etc/machine-id` is empty in the image, so systemd
  generates one per VM on first boot. Cloned VMs do not share an identity.
- **Reaching the daemon.** The daemon listens on loopback only. Nothing in this
  image publishes that port to the host. Either attach a tailnet (the sidecar,
  `tsnet.env`) or have vm-manager provide the path -- a vsock forwarder or a
  relay connection. Both are outside this image.

## Intentionally left to the operator or to vm-manager

Not oversights; each of these needs a decision that this directory cannot make
on its own.

- **Kernel.** No kernel is built or shipped here. The image is a rootfs;
  vm-manager supplies a `vmlinux` and the command line.
- **Config and data disk creation.** vm-manager builds them per VM. Making them
  from this directory would mean inventing the control plane's identity scheme.
- **Secrets.** No credential of any kind is baked into the image: no auth key,
  no pairing token, no provider credentials, no SSH key, no root password.
  Console login is disabled because no account has a password.
- **Provider credentials.** The daemon needs the user's Codex or Claude
  credentials to do anything. How they reach a project VM is an unresolved
  design question (see "Runtime integration boundaries" in
  `docs/architecture.md`); nothing here assumes an answer.
- **Snapshot and restore.** `apps/vm-manager` owns them, and must: a VM cannot
  drive its own restore. Note that a resumed snapshot wakes with a stale clock
  and with every TCP connection dead -- `systemd-timesyncd` is installed so the
  guest can resync, but making the daemon and its controllers recover from a
  resume is daemon and controller work, not image work.
- **Image distribution and versioning.** No registry, no signing, no update
  channel. The build emits a file and prints its SHA-256.
- **Host-level isolation.** Seccomp filters, cgroup limits, network policy and
  jailer configuration belong to whoever runs the hypervisor.

## Debugging a VM that will not boot

Console login is disabled on purpose, so the first tool is the serial console
output: preflight failures and systemd's unit status both appear there with
`console=ttyS0` on the kernel command line.

If interactive access is genuinely needed, enable it deliberately and only for
a throwaway build, for example by adding to the Dockerfile's final `RUN`:

```dockerfile
RUN echo 'root:<a password you choose>' | chpasswd \
    && ln -sf /lib/systemd/system/serial-getty@.service \
        /etc/systemd/system/getty.target.wants/serial-getty@ttyS0.service
```

Do not commit that. An image with a known root password is a credential in a
build definition, and it will outlive the debugging session.
