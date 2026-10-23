/**
 * Serializable sign-in state shared with clients. Kept free of Node.js
 * imports so the renderer can type-check against it.
 */

export type ConnectStatus = "waiting" | "completed" | "failed" | "cancelled";

/** Serializable snapshot of one sign-in, sent to clients on every change. */
export interface ConnectView {
  readonly connectId: string;
  readonly providerId: string;
  /** Reuse flow; retries must preserve the user's choice. */
  readonly useExistingLogin?: boolean;
  /** Account the user asked to reconnect, when this is a reconnect. */
  readonly targetAccountId?: string;
  readonly status: ConnectStatus;
  /** Sign-in page to open in a browser, once known. */
  readonly url?: string;
  /** True when the provider opened `url` itself; clients then only offer the link. */
  readonly urlOpenedByProvider?: boolean;
  /** Device-code flow: the code to enter on the sign-in page. */
  readonly userCode?: string;
  /** The provider asked for a pasted authorization code. */
  readonly needsCode: boolean;
  readonly error?: string;
  /** Account created or updated by a completed sign-in. */
  readonly accountId?: string;
  /** True when an existing account was re-authenticated. */
  readonly reconnected?: boolean;
  /** Set when a reconnect signed in as a different identity than the target. */
  readonly identityChanged?: boolean;
}
