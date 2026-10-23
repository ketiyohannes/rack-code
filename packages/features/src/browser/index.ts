/** Shared browser contracts. Remote websites never receive the application
 * bridge. Electron main implements this port; execution sees only app tools.
 */
export type BrowserAction = "state" | "navigate" | "back" | "forward" | "reload" | "snapshot" | "click" | "type" | "select" | "press" | "scroll" | "agent" | "close";
export interface BrowserRequest {
  readonly actor?: "user" | "agent";
  readonly action: BrowserAction; readonly url?: string; readonly ref?: string; readonly text?: string;
  readonly x?: number; readonly y?: number; readonly enabled?: boolean;
}
export interface BrowserSnapshot {
  readonly url: string; readonly title: string; readonly loading: boolean; readonly canGoBack: boolean;
  readonly canGoForward: boolean; readonly agentEnabled: boolean; readonly page?: string; readonly error?: string;
}
export interface BrowserDriver { control(sessionId: string, request: BrowserRequest): Promise<BrowserSnapshot> }
export interface BrowserBounds { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface BrowserPresentation { readonly sessionId?: string; readonly bounds?: BrowserBounds; readonly visible: boolean }

export class BrowserService {
  constructor(private readonly session: (id: string) => Promise<unknown>, private readonly driver: BrowserDriver) {}
  async control(sessionId: string, request: BrowserRequest): Promise<BrowserSnapshot> {
    await this.session(sessionId);
    if (request.actor === "agent" && ["agent", "close"].includes(request.action)) throw new Error("Only the user can pause, resume or close the shared browser.");
    return this.driver.control(sessionId, request);
  }
}

/** Deliberately excludes internal/file/javascript URLs for both user and agent. */
export function browserUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "") throw new Error("Use an http or https address without embedded credentials.");
  return url.href;
}
