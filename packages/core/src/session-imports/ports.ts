import type { ExternalSession, ExternalSessionSnapshot } from "./types.js";

/** Read-only native-history boundary. Implementations never start a model turn. */
export interface LocalSessionSource {
  readonly sourceId: string;
  readonly providerName: string;
  list(projectPath: string): Promise<readonly ExternalSession[]>;
  read(projectPath: string, nativeSessionId: string): Promise<ExternalSessionSnapshot>;
}
