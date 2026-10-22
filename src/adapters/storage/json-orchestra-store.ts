/** Atomic workflow library, session bindings and execution snapshots. */
import { JsonFileDocument } from "./json-file.js";
import type { OrchestraSnapshot, OrchestraStore } from "../../features/orchestration/types.js";
export class JsonOrchestraStore implements OrchestraStore {
  private readonly document: JsonFileDocument<OrchestraSnapshot>;
  constructor(path: string) { this.document = new JsonFileDocument(path, { workflows: [], bindings: {}, runs: [] }); }
  read(): Promise<OrchestraSnapshot> { return this.document.read(); }
  async update(change: (state: OrchestraSnapshot) => OrchestraSnapshot): Promise<void> { await this.document.update(change); }
}
