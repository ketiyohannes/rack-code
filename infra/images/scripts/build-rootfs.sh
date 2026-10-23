#!/usr/bin/env bash
#
# Builds the Rack daemon VM image and converts it to a bootable ext4 rootfs.
#
# Two steps, both run through Docker:
#
#   1. docker build  -- produces the guest filesystem as a container image.
#   2. docker export + mke2fs -d  -- flattens it into an ext4 image.
#
# Docker is the only requirement. The conversion runs as root inside a
# container, so the host needs no root, no loop devices and no hypervisor, and
# the script behaves identically on Linux and macOS.
#
# This script builds an image. It does not boot one: no VM is started and
# nothing here is verified against a hypervisor. See infra/images/README.md.

set -euo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly repo_root="$(cd -- "$script_dir/../../.." && pwd)"

# Configuration, all overridable from the environment.
#
# OUT_DIR defaults inside a "dist" directory because the repository's
# .gitignore excludes those at any depth: a multi-hundred-megabyte filesystem
# image must never be committed.
ARCH="${ARCH:-amd64}"
IMAGE_TAG="${IMAGE_TAG:-rack-daemon-rootfs:dev}"
OUT_DIR="${OUT_DIR:-$repo_root/infra/images/dist}"
ROOTFS_SIZE_MB="${ROOTFS_SIZE_MB:-2048}"
DAEMON_DIST="${DAEMON_DIST:-apps/daemon/dist}"
DAEMON_ENTRY="${DAEMON_ENTRY:-main.js}"
KEEP_TAR="${KEEP_TAR:-0}"

readonly imagetool_tag="${IMAGE_TAG}-imagetool"
readonly dockerfile="$repo_root/infra/images/daemon/Dockerfile"

step() { printf '\n==> %s\n' "$1"; }
die() {
	printf 'build-rootfs: %s\n' "$1" >&2
	exit 1
}

# --- preconditions ---------------------------------------------------------

command -v docker >/dev/null 2>&1 || die 'docker is required but was not found on PATH'
docker info >/dev/null 2>&1 || die 'the Docker daemon is not reachable; start Docker and try again'

# The daemon bundle is an input, not something this script can produce. Failing
# here with an explanation is much clearer than a COPY error from the build.
if [[ ! -d "$repo_root/$DAEMON_DIST" ]]; then
	die "the daemon bundle directory $DAEMON_DIST does not exist.
Build apps/daemon first, or point DAEMON_DIST at an existing bundle.
Note that apps/daemon has not been implemented yet, so there is nothing to
build at the time this script was written; see infra/images/README.md."
fi
if [[ ! -f "$repo_root/$DAEMON_DIST/$DAEMON_ENTRY" ]]; then
	die "the daemon bundle $DAEMON_DIST has no entry point $DAEMON_ENTRY.
Set DAEMON_ENTRY to the file node should run."
fi

host_arch="$(uname -m)"
case "$host_arch" in
x86_64) host_arch=amd64 ;;
aarch64 | arm64) host_arch=arm64 ;;
esac
if [[ "$host_arch" != "$ARCH" ]]; then
	printf 'build-rootfs: building linux/%s on a %s host; Docker will emulate it and the build will be slow.\n' \
		"$ARCH" "$host_arch" >&2
fi

mkdir -p "$OUT_DIR"

# --- build -----------------------------------------------------------------

step "Building the guest filesystem (linux/$ARCH)"
docker build \
	--platform "linux/$ARCH" \
	--file "$dockerfile" \
	--target rootfs \
	--build-arg "RACK_DAEMON_DIST=$DAEMON_DIST" \
	--build-arg "RACK_DAEMON_ENTRY=$DAEMON_ENTRY" \
	--tag "$IMAGE_TAG" \
	"$repo_root"

step 'Building the conversion tool'
docker build \
	--platform "linux/$ARCH" \
	--file "$dockerfile" \
	--target imagetool \
	--tag "$imagetool_tag" \
	"$repo_root"

# --- export ----------------------------------------------------------------

step 'Exporting the filesystem'
# `docker export` flattens the layers, which is what a rootfs needs: the
# per-layer whiteout files that `docker save` would keep have no meaning to a
# kernel mounting ext4.
container_id="$(docker create --platform "linux/$ARCH" "$IMAGE_TAG")"
trap 'docker rm --force "$container_id" >/dev/null 2>&1 || true' EXIT
docker export --output "$OUT_DIR/rootfs.tar" "$container_id"
docker rm "$container_id" >/dev/null
trap - EXIT

# --- convert ---------------------------------------------------------------

step "Creating the ext4 image (${ROOTFS_SIZE_MB} MiB)"
docker run --rm \
	--platform "linux/$ARCH" \
	--volume "$OUT_DIR:/out" \
	"$imagetool_tag" \
	/out/rootfs.tar /out/rootfs.ext4 "$ROOTFS_SIZE_MB"

if [[ "$KEEP_TAR" != "1" ]]; then
	rm -f "$OUT_DIR/rootfs.tar"
fi

step 'Done'
printf 'rootfs image: %s\n' "$OUT_DIR/rootfs.ext4"
if command -v sha256sum >/dev/null 2>&1; then
	sha256sum "$OUT_DIR/rootfs.ext4"
elif command -v shasum >/dev/null 2>&1; then
	shasum --algorithm 256 "$OUT_DIR/rootfs.ext4"
fi

cat <<'NEXT'

This image is a root filesystem only. To boot it you still need, from the
operator or from apps/vm-manager:

  - an uncompressed Linux kernel (vmlinux) with virtio-blk, virtio-net and
    ext4 built in,
  - a kernel command line that includes: root=/dev/vda rw init=/sbin/init
    console=ttyS0,
  - a per-VM configuration disk  (ext4, filesystem label "rack-config"),
  - a per-project data disk      (ext4, filesystem label "rack-data").

See infra/images/README.md for the contents of those two disks.
NEXT
