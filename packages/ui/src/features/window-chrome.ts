import type { WindowAction } from "@rack/contracts/transport";
import { openPopover, type PopoverHandle } from "../components/popover.js";
import { h } from "../dom.js";

/** The visible Windows/Linux menu uses the same CSS tokens as the app. Native
 * caption buttons remain OS-owned; a narrow bridge updates only their colors.
 * macOS retains its system menu and inset traffic lights.
 */
export function mountWindowChrome(): void {
  if (navigator.userAgent.includes("Macintosh")) return;
  document.documentElement.classList.add("custom-window-chrome");
  const bar = h("nav", { class: "window-chrome", role: "menubar", aria: { label: "Application menu" } });
  const groups: readonly [string, readonly [string, WindowAction, string?][]][] = [
    ["File", [["Close window", "close", "Ctrl+W"], ["Quit", "quit"]]],
    ["Edit", [["Undo", "undo", "Ctrl+Z"], ["Redo", "redo", "Ctrl+Y"], ["Cut", "cut", "Ctrl+X"], ["Copy", "copy", "Ctrl+C"], ["Paste", "paste", "Ctrl+V"], ["Select all", "selectAll", "Ctrl+A"]]],
    ["View", [["Reload", "reload", "Ctrl+R"], ["Zoom in", "zoomIn", "Ctrl++"], ["Zoom out", "zoomOut", "Ctrl+-"], ["Actual size", "resetZoom", "Ctrl+0"], ["Full screen", "fullscreen", "F11"], ["Developer tools", "devTools", "Ctrl+Shift+I"]]],
    ["Help", [["Project documentation", "help"], ["About Rack", "about"]]],
  ];
  let menu: PopoverHandle | undefined;
  let previousFocus: HTMLElement | undefined;
  const triggers: HTMLButtonElement[] = [];
  groups.forEach(([label, items], index) => {
    const trigger = h("button", { class: "window-menu-trigger", type: "button", role: "menuitem",
      aria: { haspopup: "menu", expanded: "false" },
    }, label);
    triggers.push(trigger);
    trigger.addEventListener("pointerdown", () => {
      if (!bar.contains(document.activeElement) && !menu?.element.contains(document.activeElement)) {
        previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      }
    });
    const open = () => {
      menu?.close();
      const content = h("div", { class: "window-menu", role: "menu", aria: { label } });
      const choices = items.map(([title, action, shortcut]) => h("button", {
        class: "window-menu-item", type: "button", role: "menuitem", onClick: () => {
          menu?.close(); previousFocus?.focus();
          void window.harness?.windowAction?.(action);
        },
      }, h("span", {}, title), shortcut ? h("span", { class: "window-menu-shortcut" }, shortcut) : null));
      content.append(...choices);
      content.addEventListener("keydown", (event) => {
        const current = choices.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
            : (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
          choices[next]?.focus();
        } else if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
          event.preventDefault(); triggers[(index + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length]?.click();
        } else if (event.key === "Tab") menu?.close();
      });
      menu = openPopover({ anchor: trigger, content, minWidth: 240, maxHeight: 360,
        onClose: () => { trigger.setAttribute("aria-expanded", "false"); menu = undefined; },
      });
      trigger.setAttribute("aria-expanded", "true"); choices[0]?.focus();
    };
    trigger.addEventListener("click", () => trigger.getAttribute("aria-expanded") === "true" ? menu?.close() : open());
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") { event.preventDefault(); open(); }
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault(); triggers[(index + (event.key === "ArrowRight" ? 1 : -1) + groups.length) % groups.length]?.focus();
      }
    });
    bar.append(trigger);
  });
  document.body.prepend(bar);
  // Actual computed colors resolve light-dark() palettes and live OS changes.
  const hex = (color: string): string | undefined => {
    const values = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return values ? `#${values.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}` : undefined;
  };
  const sync = () => {
    const style = getComputedStyle(bar);
    const background = hex(style.backgroundColor); const foreground = hex(style.color);
    if (background && foreground) void window.harness?.windowTheme?.({ background, foreground });
  };
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sync);
  document.addEventListener("keydown", (event) => {
    if (event.key === "F10" || (event.altKey && ["f", "e", "v", "h"].includes(event.key.toLowerCase()))) {
      event.preventDefault();
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const index = ["f", "e", "v", "h"].indexOf(event.key.toLowerCase());
      if (index < 0) triggers[0]?.focus(); else triggers[index]?.click();
    }
  });
  sync();
}
