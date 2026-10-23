/**
 * The machine registry: the service's own view of what exists.
 *
 * It is authoritative for identity, ownership labels and recorded state; the
 * driver is authoritative for the machines themselves. When the two disagree
 * (an operation failed, or the service restarted mid-operation) the record
 * says the outcome is unknown rather than quietly adopting either view.
 */
import { MachineNotFoundError } from "./errors.js";
import type { Document } from "./storage.js";
import type { MachineRecord } from "./types.js";

export interface MachineDocument {
  readonly schema: 1;
  readonly machines: readonly MachineRecord[];
}

export const EMPTY_MACHINE_DOCUMENT: MachineDocument = { schema: 1, machines: [] };

export class MachineStore {
  constructor(private readonly document: Document<MachineDocument>) {}

  async list(): Promise<readonly MachineRecord[]> {
    return (await this.document.read()).machines;
  }

  async find(machineId: string): Promise<MachineRecord | undefined> {
    return (await this.document.read()).machines.find((machine) => machine.id === machineId);
  }

  async require(machineId: string): Promise<MachineRecord> {
    const machine = await this.find(machineId);
    if (machine === undefined) throw new MachineNotFoundError(machineId);
    return machine;
  }

  async insert(record: MachineRecord): Promise<MachineRecord> {
    await this.document.update((current) => {
      if (current.machines.some((machine) => machine.id === record.id)) {
        throw new Error(`machine ${record.id} already exists`);
      }
      return { ...current, machines: [...current.machines, record] };
    });
    return record;
  }

  /**
   * Applies `change` to one machine inside the document write lock. Rules that
   * reject an illegal transition throw from `change`, which aborts the write;
   * that is how two concurrent operations on one machine are serialized.
   */
  async mutate(machineId: string, change: (record: MachineRecord) => MachineRecord): Promise<MachineRecord> {
    let updated: MachineRecord | undefined;
    await this.document.update((current) => {
      const existing = current.machines.find((machine) => machine.id === machineId);
      if (existing === undefined) throw new MachineNotFoundError(machineId);
      const next = change(existing);
      updated = next;
      return { ...current, machines: current.machines.map((machine) => (machine.id === machineId ? next : machine)) };
    });
    if (updated === undefined) throw new MachineNotFoundError(machineId);
    return updated;
  }
}
