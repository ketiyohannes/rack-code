/**
 * Application frame and window chrome.
 *
 * Regions: left sidebar (wordmark and navigator), main column (toolbar,
 * notice banner, session, composer), right workbench, and the overlay root
 * for settings.
 *
 * Both sidebars are retractable with toggle buttons in the main toolbar,
 * and resizable by dragging their inner edge (or with the keyboard on the
 * focused edge; double-click resets). Collapsed state and widths are
 * per-device preferences. Widths are applied as the `--sidebar-width` and
 * `--workbench-width` custom properties on the app root, which the grid
 * and the floating (peeked) sidebar already read. A collapsed left sidebar
 * can be "peeked": moving the pointer to the window's left edge slides it in
 * over the content, and it slides away when the pointer leaves, unless focus
 * or an open menu is still inside it. The right sidebar has no hover reveal.
 *
 * Host connectivity problems surface in the notice banner; there is no
 * "online" indicator light. The stored theme is applied before anything
 * renders so the first paint uses the right palette.
 */
import { createResizeHandle } from "../components/resize-handle.js";
import type { Controller } from "../controller.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import type { Store } from "../store.js";
import { applyTheme, loadTheme } from "../theme.js";

export interface ShellRegions {
  readonly navigator: HTMLElement;
  readonly page: HTMLElement;
  /** Slot in the toolbar for the session title and metadata. */
  readonly sessionHeader: HTMLElement;
  readonly session: HTMLElement;
  readonly composer: HTMLElement;
  readonly workbench: HTMLElement;
  readonly overlay: HTMLElement;
  /** Whether the right panel is currently shown. */
  readonly isWorkbenchVisible: () => boolean;
}

const LAYOUT_KEY = "layout.collapsed";
const WIDTHS_KEY = "layout.widths";
/** Defaults match `--sidebar-width` and `--workbench-width` in styles.css. */
const DEFAULT_WIDTHS = { left: 256, right: 320 } as const;
const MIN_WIDTHS = { left: 200, right: 260 } as const;
const MAX_WIDTHS = { left: 480, right: 760 } as const;
/**
 * The main column never shrinks below this while a panel is resized, so the
 * transcript and composer stay usable. Window resizes can still squeeze it;
 * widths are re-clamped (without saving) when that happens.
 */
const MIN_MAIN_WIDTH = 420;
/** Delay before a peeked sidebar hides, so brief pointer exits do not flicker it. */
const PEEK_HIDE_DELAY_MS = 220;

export function mountShell(root: HTMLElement, store: Store, controller: Controller): ShellRegions {
  applyTheme(loadTheme());
  // macOS uses an inset title bar; the toolbar leaves room for the window
  // controls when the left sidebar is collapsed.
  if (navigator.userAgent.includes("Macintosh")) {
    document.documentElement.classList.add("platform-mac");
  }

  const layout = loadLayout();
  const sidebar = h("aside", { class: "sidebar" });
  const workbench = h("aside", { class: "workbench" });
  const regions: ShellRegions = {
    page: h("section", { class: "workspace-page" }),
    navigator: h("div", { class: "sidebar-body" }),
    sessionHeader: h("div", { class: "toolbar-title" }),
    session: h("div", { class: "session" }),
    composer: h("div", { class: "composer-region" }),
    workbench,
    overlay: h("div", { class: "overlay-root" }),
    isWorkbenchVisible: () => !layout.right && store.get().page === "chat",
  };

  const leftToggle = toggleButton("Toggle sidebar", "sidebar-simple", () => setCollapsed("left", !layout.left));
  const rightToggle = toggleButton("Toggle right panel", "sidebar-simple", () => setCollapsed("right", !layout.right), "mirrored");
  const notice = h("div", { class: "notice", aria: { live: "polite" } });
  const hoverZone = h("div", { class: "peek-zone", aria: { hidden: "true" } });

  sidebar.append(
    h("div", { class: "sidebar-top" }, h("span", { class: "wordmark" }, "thinking & code")),
    regions.navigator,
  );
  root.append(
    sidebar,
    h("main", { class: "main" },
      h("header", { class: "toolbar" }, leftToggle, regions.sessionHeader, rightToggle),
      regions.page,
      regions.session,
      regions.composer,
    ),
    workbench,
    hoverZone,
    regions.overlay,
    notice,
  );
  workbench.append(h("div", { class: "workbench-top" }));

  // --- Collapse and peek ------------------------------------------------------
  let hideTimer: number | undefined;
  const peek = (show: boolean) => {
    window.clearTimeout(hideTimer);
    if (show) {
      sidebar.classList.add("peek");
      return;
    }
    hideTimer = window.setTimeout(() => {
      // Keep the sidebar while the user is typing in it or using one of its menus.
      const menuOpen = document.querySelector(".popover") !== null;
      if (sidebar.contains(document.activeElement) || menuOpen) return;
      sidebar.classList.remove("peek");
    }, PEEK_HIDE_DELAY_MS);
  };
  hoverZone.addEventListener("pointerenter", () => peek(true));
  sidebar.addEventListener("pointerenter", () => layout.left && peek(true));
  sidebar.addEventListener("pointerleave", () => layout.left && peek(false));
  sidebar.addEventListener("focusout", () => layout.left && peek(false));

  function setCollapsed(side: "left" | "right", collapsed: boolean): void {
    layout[side] = collapsed;
    saveLayout(layout);
    applyLayout();
    // Showing a panel takes space from the main column; re-fit both widths.
    // (Declared below; only invoked after mounting completes.)
    fitWidths();
  }

  function applyLayout(): void {
    root.classList.toggle("left-collapsed", layout.left);
    root.classList.toggle("right-collapsed", layout.right);
    sidebar.classList.remove("peek");
    leftToggle.setAttribute("aria-pressed", String(!layout.left));
    rightToggle.setAttribute("aria-pressed", String(!layout.right));
  }
  applyLayout();

  // --- Panel widths -----------------------------------------------------------
  const widths = loadWidths();
  const cssVariable = { left: "--sidebar-width", right: "--workbench-width" } as const;
  /** Largest width for `side` that keeps the main column at its minimum. */
  const maxWidth = (side: "left" | "right") => {
    const other = side === "left" ? "right" : "left";
    const otherWidth = layout[other] ? 0 : widths[other];
    return Math.min(MAX_WIDTHS[side], window.innerWidth - otherWidth - MIN_MAIN_WIDTH);
  };
  const setWidth = (side: "left" | "right", width: number) => {
    widths[side] = width;
    root.style.setProperty(cssVariable[side], `${width}px`);
  };
  for (const side of ["left", "right"] as const) {
    setWidth(side, widths[side]);
    const handle = createResizeHandle({
      label: side === "left" ? "Resize sidebar" : "Resize right panel",
      edge: side === "left" ? "right" : "left",
      min: MIN_WIDTHS[side],
      max: () => maxWidth(side),
      defaultWidth: DEFAULT_WIDTHS[side],
      width: () => widths[side],
      onResize: (width) => setWidth(side, width),
      onCommit: () => saveWidths(widths),
    });
    (side === "left" ? sidebar : workbench).append(handle);
  }
  // Shrinking the window can leave saved widths too large for the space.
  // Clamp what is shown, but keep the saved preference for larger windows.
  const fitWidths = () => {
    for (const side of ["left", "right"] as const) {
      const fitted = Math.max(MIN_WIDTHS[side], Math.min(widths[side], maxWidth(side)));
      root.style.setProperty(cssVariable[side], `${fitted}px`);
    }
  };
  window.addEventListener("resize", fitWidths);
  fitWidths();

  store.watch((state) => state.page, (page) => {
    root.dataset.page = page;
    regions.page.hidden = page === "chat";
    regions.session.hidden = page !== "chat";
    regions.composer.hidden = page !== "chat";
    regions.sessionHeader.hidden = page !== "chat";
  });

  // --- Notice banner ----------------------------------------------------------
  store.watch((state) => [state.notice, state.host], (_slice, state) => {
    const offline = state.host.status === "exited"
      ? { kind: "error" as const, message: state.host.detail ?? "The execution host stopped. Restart the app to reconnect." }
      : undefined;
    const current = state.notice ?? offline;
    notice.hidden = current === undefined;
    if (current === undefined) {
      notice.replaceChildren();
      return;
    }
    notice.className = `notice notice-${current.kind}`;
    const action = state.notice?.action;
    replace(notice,
      icon(current.kind === "error" ? "warning-circle" : "info"),
      h("span", { class: "notice-text" }, current.message),
      state.notice?.code === undefined ? null : h("span", { class: "notice-code" }, state.notice.code),
      action === undefined ? null : h("button", { class: "button button-small", onClick: () => {
        controller.dismissNotice();
        action.run();
      } }, icon("arrow-clockwise"), action.label),
      state.notice === undefined ? null : h("button", {
        class: "icon-button",
        title: "Dismiss",
        aria: { label: "Dismiss" },
        onClick: () => controller.dismissNotice(),
      }, icon("x")),
    );
  });

  return regions;
}

function toggleButton(label: string, iconName: Parameters<typeof icon>[0], onClick: () => void, extraClass = ""): HTMLButtonElement {
  return h("button", { class: `icon-button toolbar-toggle ${extraClass}`.trim(), title: label, aria: { label }, onClick }, icon(iconName));
}

function loadLayout(): { left: boolean; right: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as { left?: unknown; right?: unknown };
    return { left: stored.left === true, right: stored.right === true };
  } catch {
    return { left: false, right: false };
  }
}

/** Saved panel widths, falling back to the defaults for missing or invalid values. */
function loadWidths(): { left: number; right: number } {
  try {
    const stored = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "{}") as { left?: unknown; right?: unknown };
    const valid = (value: unknown, side: "left" | "right") =>
      typeof value === "number" && Number.isFinite(value) && value >= MIN_WIDTHS[side] && value <= MAX_WIDTHS[side] ? value : DEFAULT_WIDTHS[side];
    return { left: valid(stored.left, "left"), right: valid(stored.right, "right") };
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
}

function saveWidths(widths: { left: number; right: number }): void {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Widths are a convenience; losing them restores the defaults.
  }
}

function saveLayout(layout: { left: boolean; right: boolean }): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Layout is a convenience; losing it restores both sidebars.
  }
}
