import type { BrowserBounds } from "../../features/browser/index.js";
/** DOM rectangles use zoomed CSS pixels; native views use DIP coordinates.
 * Apply only Electron's page zoom (not devicePixelRatio/OS display scale),
 * then clamp to the owning content area so pages cannot cover app chrome.
 */
export function browserViewBounds(bounds: BrowserBounds, size: readonly number[], zoom = 1): BrowserBounds {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = Math.max(0, size[0] ?? 0); const height = Math.max(0, size[1] ?? 0);
  const x = Math.max(0, Math.min(Math.round(bounds.x * factor), width));
  const y = Math.max(0, Math.min(Math.round(bounds.y * factor), height));
  return { x, y, width: Math.max(0, Math.min(Math.round(bounds.width * factor), width - x)), height: Math.max(0, Math.min(Math.round(bounds.height * factor), height - y)) };
}
