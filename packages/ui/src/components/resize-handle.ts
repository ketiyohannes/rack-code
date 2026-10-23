/**
 * Draggable splitter for resizing a side panel or the prompt area.
 *
 * The handle is placed on one edge of a panel and reports its new size
 * through callbacks; it owns no layout state itself. The caller decides how
 * the size is applied (the shell sets a CSS custom property) and when it is
 * persisted.
 *
 * Interaction:
 * - pointer drag resizes live through `onResize` and calls `onCommit` once
 *   on release, so storage is written once per drag rather than per frame;
 * - double-click restores `defaultWidth`;
 * - keyboard (the handle is a focusable `separator`): directional arrows step
 *   by 16 px (64 px with Shift), Home/End jump to the minimum/maximum.
 *   Top/bottom edges use Up/Down and report height through the size callbacks.
 *
 * Widths are always clamped to `[min, max()]`. `max` is a function because
 * the allowed maximum depends on the window size and the other panel.
 */
import { h } from "../dom.js";

export interface ResizeHandleOptions {
  /** Accessible name, for example "Resize sidebar". */
  readonly label: string;
  /**
   * Which edge of the panel the handle sits on. A handle on the panel's
   * right edge grows the panel when dragged right; on the left edge, when
   * dragged left. Top/bottom edges grow the panel when dragged outward.
   */
  readonly edge: "left" | "right" | "top" | "bottom";
  readonly min: number;
  readonly max: () => number;
  readonly defaultWidth: number;
  /** Current panel size in CSS pixels (height for a top/bottom edge). */
  readonly width: () => number;
  /** Applies a clamped width during interaction. */
  readonly onResize: (width: number) => void;
  /** Persists the final width after a drag, key press, or reset. */
  readonly onCommit: (width: number) => void;
}

const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

export function createResizeHandle(options: ResizeHandleOptions): HTMLElement {
  const horizontal = options.edge === "top" || options.edge === "bottom";
  const handle = h("div", { class: `resize-handle${horizontal ? " resize-handle-horizontal" : ""}`, role: "separator", title: `${options.label} (double-click to reset)`, aria: { label: options.label, orientation: horizontal ? "horizontal" : "vertical" } });
  handle.tabIndex = 0;

  const clamp = (width: number) => Math.round(Math.min(Math.max(width, options.min), Math.max(options.min, options.max())));
  const apply = (width: number, commit: boolean) => {
    const clamped = clamp(width);
    options.onResize(clamped);
    syncAria(clamped);
    if (commit) options.onCommit(clamped);
  };
  const syncAria = (width: number) => {
    handle.setAttribute("aria-valuemin", String(options.min));
    handle.setAttribute("aria-valuemax", String(Math.max(options.min, Math.round(options.max()))));
    handle.setAttribute("aria-valuenow", String(width));
  };
  // Grows the panel for movement away from the main column.
  const direction = options.edge === "right" || options.edge === "bottom" ? 1 : -1;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startPosition = horizontal ? event.clientY : event.clientX;
    const startWidth = options.width();
    let latest = startWidth;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    // Keeps the resize cursor and prevents text selection while the pointer
    // is outside the handle during a fast drag.
    document.documentElement.classList.add("resizing");
    document.documentElement.classList.toggle("resizing-rows", horizontal);
    // Native browser views sit above the renderer. Tell them to detach before
    // the pointer leaves this handle so they cannot swallow the drag.
    window.dispatchEvent(new Event("layout-resize"));

    const move = (moveEvent: PointerEvent) => {
      latest = clamp(startWidth + ((horizontal ? moveEvent.clientY : moveEvent.clientX) - startPosition) * direction);
      apply(latest, false);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      handle.classList.remove("dragging");
      document.documentElement.classList.remove("resizing", "resizing-rows");
      window.dispatchEvent(new Event("layout-resize"));
      apply(latest, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    // Capture can be lost when the OS interrupts a drag; always release the
    // global resize cursor and commit the last visible width in that case.
    handle.addEventListener("lostpointercapture", end);
  });

  handle.addEventListener("dblclick", () => apply(options.defaultWidth, true));

  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const current = options.width();
    let next: number | undefined;
    if (event.key === (horizontal ? "ArrowDown" : "ArrowRight")) next = current + step * direction;
    else if (event.key === (horizontal ? "ArrowUp" : "ArrowLeft")) next = current - step * direction;
    else if (event.key === "Home") next = options.min;
    else if (event.key === "End") next = options.max();
    if (next === undefined) return;
    event.preventDefault();
    apply(next, true);
  });

  syncAria(clamp(options.width()));
  // Window fitting happens outside this component; announce its current
  // bounds when keyboard users return to the separator.
  handle.addEventListener("focus", () => syncAria(clamp(options.width())));
  return handle;
}
