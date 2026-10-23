/**
 * File-backed development driver. It runs no hypervisor.
 *
 * A "machine" is a directory holding a `machine.json` description and a
 * `disk.img` file; a snapshot is a copy of that file. Nothing boots, and no
 * guest ever runs, so this driver is useless for running agents. What it does
 * reproduce faithfully is the part the service depends on: operations take
 * time, can fail, and a restore really does replace the machine's current disk
 * contents with the captured ones. That makes safe-shot behaviour observable
 * in tests without a VPS, and the file layout mirrors the one a real driver
 * would manage.
 *
 * `capabilities.simulated` is true and is reported by the health endpoint, so
 * a process running this driver cannot be mistaken for one managing real VMs.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DriverHandle, MachineSpec, SnapshotRecord } from "../types.js";
import type { MachineDriver, SnapshotResult } from "./types.js";

/** Guards the path joins below: identifiers come from the service, but a
 * driver that writes to paths built from input should never trust them. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface LocalMachineFile {
  readonly id: string;
  readonly spec: MachineSpec;
  readonly power: "running" | "stopped";
  readonly simulated: true;
}

export function createLocalDriver(stateDirectory: string): MachineDriver {
  const machineDirectory = (machineId: string): string => {
    if (!IDENTIFIER.test(machineId)) throw new Error(`unsafe machine identifier: ${machineId}`);
    return join(stateDirectory, "machines", machineId);
  };

  const snapshotPath = (machineId: string, snapshotId: string): string => {
    if (!IDENTIFIER.test(snapshotId)) throw new Error(`unsafe snapshot identifier: ${snapshotId}`);
    return join(machineDirectory(machineId), "snapshots", `${snapshotId}.img`);
  };

  const diskPath = (handle: DriverHandle, machineId: string): string => handle["disk"] ?? join(machineDirectory(machineId), "disk.img");

  const setPower = async (machineId: string, power: LocalMachineFile["power"]): Promise<void> => {
    const descriptor = join(machineDirectory(machineId), "machine.json");
    const current = JSON.parse(await readFile(descriptor, "utf8")) as LocalMachineFile;
    await writeFile(descriptor, `${JSON.stringify({ ...current, power }, null, 2)}\n`, "utf8");
  };

  return {
    name: "local",
    capabilities: { implemented: true, simulated: true, liveSnapshots: false },

    async create(machineId, spec) {
      const directory = machineDirectory(machineId);
      await mkdir(join(directory, "snapshots"), { recursive: true });
      const disk = join(directory, "disk.img");
      // The initial disk content stands in for a provisioned rootfs; tests
      // rewrite it to represent work done inside the machine.
      await writeFile(disk, `image=${spec.image}\ngeneration=0\n`, "utf8");
      const descriptor: LocalMachineFile = { id: machineId, spec, power: "running", simulated: true };
      await writeFile(join(directory, "machine.json"), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
      return { directory, disk };
    },

    async start(machineId) {
      await setPower(machineId, "running");
    },

    async stop(machineId) {
      await setPower(machineId, "stopped");
    },

    async snapshot(machineId, handle, snapshotId): Promise<SnapshotResult> {
      const target = snapshotPath(machineId, snapshotId);
      await mkdir(join(machineDirectory(machineId), "snapshots"), { recursive: true });
      await copyFile(diskPath(handle, machineId), target);
      return { handle: { disk: target }, sizeBytes: (await stat(target)).size };
    },

    async restore(machineId, handle, snapshot) {
      const source = snapshot.handle["disk"];
      if (source === undefined) throw new Error(`snapshot ${snapshot.id} has no recorded disk`);
      // Copy rather than move: restoring the same snapshot repeatedly is the
      // normal case for safe shots, so the capture must survive the restore.
      await copyFile(source, diskPath(handle, machineId));
      await setPower(machineId, "stopped");
    },

    async deleteSnapshot(machineId, _handle, snapshot) {
      const source = snapshot.handle["disk"] ?? snapshotPath(machineId, snapshot.id);
      await rm(source, { force: true });
    },

    async destroy(machineId) {
      await rm(machineDirectory(machineId), { recursive: true, force: true });
    },
  };
}
