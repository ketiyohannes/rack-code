import type { SessionImportMessage, SessionImportSource, SessionImportSnapshot, SessionRecord } from "../sessions/types.js";

// Sessions owns the input it accepts; discovery reuses those provider-neutral
// values rather than making the core session service depend on its importer.
export type ExternalSession = SessionImportSource;
export type ImportedMessage = SessionImportMessage;
export type ExternalSessionSnapshot = SessionImportSnapshot;

export interface DiscoveredSession extends ExternalSession {
  readonly importedSessionId?: string;
}

export interface SessionDiscovery {
  readonly sessions: readonly DiscoveredSession[];
  readonly failures: readonly { readonly sourceId: string; readonly providerName: string; readonly message: string }[];
}

export interface ImportSessionResult {
  readonly session: SessionRecord;
  readonly alreadyImported: boolean;
}
