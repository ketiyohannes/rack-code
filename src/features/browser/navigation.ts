/** User-facing omnibox parsing. Agent navigation still requires an explicit
 * HTTP(S) address through browserUrl; search is a user toolbar convenience.
 */
import { browserUrl } from "./index.js";
export function browserAddress(value: string): string {
  const text = value.trim();
  if (!text) throw new Error("Enter an address or search.");
  if (text.includes("://") || /^(?:javascript|data|file|about|chrome):/i.test(text)) return browserUrl(text);
  if (/^(?:localhost|127(?:\.\d+){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(text)) return browserUrl(`http://${text}`);
  if (/\s/.test(text) || !/^[^/\s]+\.[^/\s]+(?:\/|$)/.test(text)) return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
  return browserUrl(text);
}
