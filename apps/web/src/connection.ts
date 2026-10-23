/**
 * Where a browser controller keeps the details of the daemon it talks to.
 *
 * The pairing token is the only thing standing between a visitor and a
 * command surface that can read files and run processes on the daemon's
 * machine, so where it is stored is a real decision rather than a detail:
 *
 * - **By default it lives in `sessionStorage`**, which is scoped to the tab
 *   and cleared when the tab closes. A token left in `localStorage` on a
 *   shared or borrowed machine survives indefinitely and is readable by any
 *   script that ever manages to run on this origin.
 * - **`localStorage` is opt-in**, behind an explicit "remember on this
 *   device" choice, because on a personal machine retyping a 43-character
 *   token every session is the kind of friction that makes people pick
 *   worse credentials.
 *
 * The daemon address and the client identifier are not secrets and are
 * always persisted, so only the token has to be re-entered.
 */
export interface ConnectionSettings {
  /** Daemon endpoint, for example `wss://daemon.example.net/rack`. */
  readonly url: string;
  readonly token: string;
  /** Persist the token across tabs and restarts on this device. */
  readonly remember: boolean;
}

const URL_KEY = "rack.daemon.url";
const TOKEN_KEY = "rack.daemon.token";
const CLIENT_KEY = "rack.client-id";

/**
 * Stable identifier for this browser profile. Not a secret and not a
 * credential: the daemon uses it only to label connections in its logs, so
 * a user can tell their devices apart.
 */
export function clientId(): string {
  const existing = localStorage.getItem(CLIENT_KEY);
  if (existing !== null && existing !== "") return existing;
  const created = `web-${crypto.randomUUID()}`;
  localStorage.setItem(CLIENT_KEY, created);
  return created;
}

export function loadSettings(): ConnectionSettings | undefined {
  const url = localStorage.getItem(URL_KEY);
  if (url === null || url === "") return undefined;
  // A remembered token is in localStorage; a session token is in
  // sessionStorage. Checking localStorage first preserves `remember`.
  const remembered = localStorage.getItem(TOKEN_KEY);
  const token = remembered ?? sessionStorage.getItem(TOKEN_KEY);
  if (token === null || token === "") return undefined;
  return { url, token, remember: remembered !== null };
}

export function saveSettings(settings: ConnectionSettings): void {
  localStorage.setItem(URL_KEY, settings.url);
  if (settings.remember) {
    localStorage.setItem(TOKEN_KEY, settings.token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, settings.token);
    localStorage.removeItem(TOKEN_KEY);
  }
}

/** Forgets the token everywhere; the address is kept for convenience. */
export function forgetToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
}

/**
 * Validates and normalizes a daemon address.
 *
 * `http`/`https` are accepted and rewritten, because that is what users
 * paste; a plaintext `ws://` to anything other than loopback is refused,
 * since the pairing token would cross the network in the clear.
 */
export function normalizeUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { error: "Enter the daemon address." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `wss://${trimmed}`);
  } catch {
    return { error: "That is not a valid address." };
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { error: "The address must be a ws:// or wss:// URL." };
  }
  if (parsed.protocol === "ws:" && !isLoopback(parsed.hostname)) {
    return { error: "Use wss:// for a remote daemon; ws:// would send the pairing token in the clear." };
  }
  if (parsed.pathname === "/" || parsed.pathname === "") parsed.pathname = "/rack";
  return { url: parsed.toString() };
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
