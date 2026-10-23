/** Per-device context/session mapping and automatic PR dock visibility.
 * Saved session existence alone is insufficient: empty or deleted chats stay
 * closed. A visit checks history once; explicit toggles win over late replies.
 */
import type { HostClient } from "@rack/client/host-client";

const STORAGE_KEY = "sideChat.sessions";

export function loadSessions(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    return value !== null && typeof value === "object" ? value as Record<string, string> : {};
  } catch { return {}; }
}
export function saveSession(key: string, sessionId: string | undefined): void {
  const sessions = loadSessions();
  if (sessionId === undefined) delete sessions[key]; else sessions[key] = sessionId;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions)); } catch { /* The chat still works for this window. */ }
}

/** One state per PR surface; changing PR or leaving it starts a fresh visit. */
export function createSideChatVisibility(host: Pick<HostClient, "call">, onChange: (open: boolean) => void) {
  let key: string | undefined;
  let revision = 0;
  return {
    select(next: string | undefined): void {
      if (next === key) return;
      key = next;
      const request = ++revision;
      onChange(false);
      const sessionId = next === undefined ? undefined : loadSessions()[next];
      if (!sessionId) return;
      void host.call("sessions.get", { sessionId }).then(session => {
        if (request === revision && session.messages.length > 0) onChange(true);
      }).catch(() => { /* Missing or unavailable history leaves the dock closed. */ });
    },
    set(open: boolean): void {
      revision++;
      onChange(open);
    },
  };
}
