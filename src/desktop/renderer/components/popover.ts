/**
 * Floating surface anchored to a trigger element.
 *
 * Used by dropdown menus and small inline editors. Behavior:
 * - only one popover is open at a time; opening another closes the first;
 * - it is positioned with `position: fixed` against the anchor's rectangle,
 *   below the anchor when there is room and above it otherwise (the
 *   composer sits at the bottom of the window, so its menus open upward);
 * - its height is capped (`maxHeight`, 320 px by default) so long lists such
 *   as the model catalog scroll inside a short box instead of filling the
 *   window; short menus keep their natural height;
 * - it closes on Escape, on a pointer press outside both the popover and its
 *   anchor, on window resize, and on scroll of any ancestor;
 * - `onClose` runs exactly once, after the element is removed.
 *
 * The popover is appended to `document.body` so it is never clipped by a
 * scrolling or `overflow: hidden` ancestor.
 */

export interface PopoverOptions {
  readonly anchor: HTMLElement;
  /** Cursor position for context menus; anchor still owns dismissal/focus. */
  readonly point?: { readonly x: number; readonly y: number };
  readonly content: HTMLElement;
  /** Minimum width in pixels; defaults to the anchor's width. */
  readonly minWidth?: number;
  /** Maximum width in pixels (default 400) so long descriptions wrap. */
  readonly maxWidth?: number;
  /**
   * Maximum height in pixels (default `DEFAULT_MAX_HEIGHT`). The content
   * scrolls beyond it. The space left in the window can lower it further.
   */
  readonly maxHeight?: number;
  /** Horizontal alignment relative to the anchor. */
  readonly align?: "start" | "end";
  /** Attachment actions explicitly open upward; other menus choose the available side. */
  readonly placement?: "above" | "auto";
  readonly onClose?: () => void;
}

/** Default height cap: about eight two-line options, then the list scrolls. */
const DEFAULT_MAX_HEIGHT = 320;

export interface PopoverHandle {
  readonly element: HTMLElement;
  /** Re-anchor after replacing content, for example a model list becoming a slider. */
  reposition(): void;
  close(): void;
}

let current: PopoverHandle | undefined;

export function openPopover(options: PopoverOptions): PopoverHandle {
  current?.close();

  const element = document.createElement("div");
  element.className = "popover";
  element.append(options.content);
  document.body.append(element);

  let closed = false;
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!element.contains(target) && (options.point || !options.anchor.contains(target))) handle.close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handle.close();
      options.anchor.focus({ preventScroll: true });
    }
  };
  const onViewportChange = (event: Event) => {
    // Scrolling inside the popover itself (a long menu) must not close it.
    if (event.type === "scroll" && element.contains(event.target as Node)) return;
    handle.close();
  };

  const handle: PopoverHandle = {
    element,
    reposition() {
      if (closed) return;
      element.style.maxHeight = "";
      position(element, options);
    },
    close() {
      if (closed) return;
      closed = true;
      element.remove();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onViewportChange);
      document.removeEventListener("scroll", onViewportChange, true);
      if (current === handle) current = undefined;
      options.onClose?.();
    },
  };

  position(element, options);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  document.addEventListener("scroll", onViewportChange, true);
  current = handle;
  return handle;
}

function position(element: HTMLElement, options: PopoverOptions): void {
  const gap = 6;
  const margin = 8;
  const rect = options.point
    ? { left: options.point.x, right: options.point.x, top: options.point.y, bottom: options.point.y, width: 0 }
    : options.anchor.getBoundingClientRect();
  const maxWidth = Math.min(Math.max(options.maxWidth ?? 400, options.minWidth ?? 0), window.innerWidth - margin * 2);
  element.style.minWidth = `${Math.min(Math.max(options.minWidth ?? 0, rect.width), maxWidth)}px`;
  element.style.maxWidth = `${maxWidth}px`;

  // Placement uses the capped height: a long list that will scroll at the
  // cap should not flip sides just because its full content is tall.
  const cap = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const height = Math.min(element.offsetHeight, cap);
  const below = window.innerHeight - rect.bottom - gap - margin;
  const above = rect.top - gap - margin;
  const openAbove = options.placement === "above" || (height > below && above > below);
  const available = Math.min(openAbove ? above : below, cap);
  element.style.maxHeight = `${available}px`;
  element.style.top = openAbove
    ? `${Math.max(margin, rect.top - gap - Math.min(height, available))}px`
    : `${rect.bottom + gap}px`;

  const width = element.offsetWidth;
  const left = options.align === "end" ? rect.right - width : rect.left;
  element.style.left = `${Math.min(Math.max(margin, left), window.innerWidth - width - margin)}px`;
  element.dataset["placement"] = openAbove ? "above" : "below";
}
