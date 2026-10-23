# syntax=docker/dockerfile:1
#
# Build definition for the Rack daemon VM image.
#
# The build context is the repository root, because the image needs both the Go
# sidecar (native/tsnet-sidecar) and the daemon bundle (apps/daemon/dist):
#
#   docker build -f infra/images/daemon/Dockerfile .
#
# Use infra/images/scripts/build-rootfs.sh rather than calling docker directly;
# it also converts the result into the ext4 rootfs that a microVM boots from.
#
# Why a Dockerfile and not a Packer template: see infra/images/README.md.
# In short, the guest is a container-sized Debian with systemd as PID 1, and
# describing it as a Dockerfile keeps the build reproducible and runnable on any
# machine with Docker, without a hypervisor or nested virtualization.

ARG DEBIAN_RELEASE=bookworm
ARG GO_VERSION=1.25
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1: build the tsnet sidecar from source in this repository.
#
# The sidecar is pure Go, so CGO is disabled and the binary is static; it runs
# on the Debian rootfs below without any runtime dependency. This stage needs
# network access to fetch the Go module cache.
# ---------------------------------------------------------------------------
FROM golang:${GO_VERSION}-${DEBIAN_RELEASE} AS sidecar-build

WORKDIR /src

# Copy the module files first so the dependency download is cached separately
# from the source, which changes far more often.
COPY native/tsnet-sidecar/go.mod native/tsnet-sidecar/go.sum ./
RUN go mod download

COPY native/tsnet-sidecar/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" \
        -o /out/tsnet-sidecar ./cmd/tsnet-sidecar

# ---------------------------------------------------------------------------
# Stage 2: the Node.js runtime.
#
# Only the interpreter is taken from the official image. The daemon ships as a
# bundle, so npm, corepack and the headers are not needed in the guest, and
# leaving them out keeps the rootfs smaller and the attack surface narrower.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS node-runtime

# ---------------------------------------------------------------------------
# Stage 3: the guest rootfs.
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim AS rootfs

# Path (relative to the build context) of the built daemon. There is no default
# that could silently produce an image without a daemon: if this path does not
# exist, the COPY below fails the build.
ARG RACK_DAEMON_DIST=apps/daemon/dist

# Entry point inside the bundle, passed to node by the systemd unit.
ARG RACK_DAEMON_ENTRY=main.js

ENV DEBIAN_FRONTEND=noninteractive

# systemd and systemd-sysv provide PID 1; dbus is required by systemd's own
# IPC. The rest is the minimum an agent harness needs to be useful: a CA
# bundle for HTTPS to the model providers, git and ssh for repositories, and
# basic network and process tools for diagnosis from the serial console.
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        dbus \
        git \
        iproute2 \
        iputils-ping \
        less \
        openssh-client \
        procps \
        systemd \
        systemd-sysv \
        systemd-timesyncd \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=sidecar-build /out/tsnet-sidecar /usr/local/bin/tsnet-sidecar

# The daemon bundle. Build it for linux and for this image's architecture;
# see infra/images/README.md for the native-module caveat.
COPY ${RACK_DAEMON_DIST}/ /opt/rack/daemon/

# Units, users and the preflight check.
COPY infra/images/daemon/rootfs/ /

RUN set -eux; \
    chmod 0755 /usr/local/sbin/rack-preflight; \
    \
    # Record the daemon entry point for the unit, so that changing it is a
    # build argument rather than an edit of the unit file.
    mkdir -p /etc/rack; \
    printf 'RACK_DAEMON_ENTRY=%s\n' "${RACK_DAEMON_ENTRY}" > /etc/rack/daemon-entry.env; \
    \
    # Create the service accounts from the shipped sysusers fragment. The
    # daemon runs as "rack"; the sidecar runs as "rack-tsnet" so that a
    # compromised agent process cannot read the tailnet node key.
    systemd-sysusers; \
    \
    # Mount point for the project data disk. systemd would create it on
    # demand, but shipping it with the right owner means the daemon's user
    # has a usable home even before the mount unit runs.
    install -d -o rack -g rack -m 0750 /var/lib/rack; \
    \
    # Enable units by creating the symlinks that `systemctl enable` would
    # create. systemctl is not used here because there is no running systemd
    # inside a build container, and explicit symlinks make the enabled set
    # obvious when reviewing the image.
    mkdir -p /etc/systemd/system/multi-user.target.wants; \
    ln -sf /etc/systemd/system/rack-daemon.service \
        /etc/systemd/system/multi-user.target.wants/rack-daemon.service; \
    ln -sf /etc/systemd/system/rack-tsnet-sidecar.service \
        /etc/systemd/system/multi-user.target.wants/rack-tsnet-sidecar.service; \
    \
    # Firecracker's only graceful stop signal is Ctrl+Alt+Del. By default
    # systemd maps it to reboot; mapping it to poweroff lets apps/vm-manager
    # shut a microVM down cleanly instead of killing the process.
    ln -sf /lib/systemd/system/poweroff.target /etc/systemd/system/ctrl-alt-del.target; \
    \
    # A microVM has no graphical layer, so multi-user.target is the goal.
    # This is what `systemctl set-default` writes; it is done by hand for the
    # same reason as the unit symlinks above.
    ln -sf /lib/systemd/system/multi-user.target /etc/systemd/system/default.target; \
    \
    # /etc/machine-id must be empty in the image: systemd generates a fresh
    # one on first boot, so cloned VMs do not share an identity. The
    # conversion script asserts this again after export.
    : > /etc/machine-id

# No credential of any kind is baked into this image. Debian's base image ships
# a locked root account and nothing above adds a password to any account, so
# console login is disabled; infra/images/README.md explains how to enable it
# deliberately when debugging a VM that will not boot.

# The image is a rootfs, not a service container: it is exported and converted
# to an ext4 filesystem by infra/images/scripts/build-rootfs.sh, and booted by
# the hypervisor with init=/sbin/init. The CMD exists only so that running the
# image directly fails with an explanation instead of an obscure error.
CMD ["/bin/sh", "-c", "echo 'This image is a VM rootfs. Build it with infra/images/scripts/build-rootfs.sh and boot it as a microVM.' >&2; exit 64"]

# ---------------------------------------------------------------------------
# Stage 4: the conversion tool.
#
# Turning the exported rootfs into an ext4 image needs e2fsprogs and file
# ownership that only root can set. Running that step inside this stage means
# the build needs Docker and nothing else: no root on the host, no loop
# devices, and therefore no difference between Linux and macOS.
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim AS imagetool

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install --no-install-recommends --yes e2fsprogs \
    && rm -rf /var/lib/apt/lists/*

COPY infra/images/daemon/imagetool/make-rootfs-image /usr/local/sbin/make-rootfs-image
RUN chmod 0755 /usr/local/sbin/make-rootfs-image

ENTRYPOINT ["/usr/local/sbin/make-rootfs-image"]
