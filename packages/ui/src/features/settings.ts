/**
 * Settings overlay: a full-window dialog with section navigation.
 *
 * Implemented sections: General (appearance), Accounts (account
 * management, which also hosts re-authentication), Models (star favorites), and Plugins (enable
 * right-panel surfaces; Timeline, Terminal, Browser and Files are functional).
 * Shortcuts documents existing controls and About describes the local app.
 * Planned settings stay out of navigation until their behavior is implemented.
 *
 * Opening and the active section live in the store, so other features can
 * deep-link (for example, "Re-authenticate account" opens Accounts). Closing
 * works with the close button, Escape, or a click on the backdrop.
 */
import type { Controller } from "../controller.js";
import { h, replace } from "../dom.js";
import { icon, type IconName } from "../icons.js";
import type { SettingsSection, Store } from "../store.js";
import { applyPalette, applyTheme, loadPalette, loadTheme, type ThemePalette, type ThemePreference } from "../theme.js";
import { SURFACES } from "../surfaces.js";
import { mountAccounts } from "./accounts.js";
import { mountModelsSettings } from "./models-settings.js";

/** Replaced with package.json metadata by the desktop bundler. */
declare const __APP_VERSION__: string;

interface SectionInfo {
  readonly id: SettingsSection;
  readonly title: string;
  readonly icon: IconName;
}

const SECTIONS: readonly SectionInfo[] = [
  { id: "general", title: "General", icon: "sliders-horizontal" },
  { id: "accounts", title: "Accounts", icon: "user-circle" },
  { id: "models", title: "Models", icon: "star" },
  { id: "plugins", title: "Plugins", icon: "puzzle-piece" },
  { id: "shortcuts", title: "Shortcuts", icon: "keyboard" },
  { id: "about", title: "About", icon: "info" },
];

const THEMES: ReadonlyArray<readonly [ThemePreference, IconName, string, string]> = [
  ["light", "sun", "Light", "Always light"],
  ["dark", "moon", "Dark", "Always dark"],
  ["system", "desktop", "System", "Follow the operating system"],
];

const PALETTES: ReadonlyArray<readonly [ThemePalette, string]> = [
  ["neutral", "Neutral"], ["emerald", "Emerald"], ["burgundy", "Burgundy"], ["purple", "Purple"],
  ["flexoki", "Flexoki"],
];

export function mountSettings(root: HTMLElement, store: Store, controller: Controller): void {
  let wasOpen = false;
  let previousFocus: HTMLElement | undefined;
  const background = new Map<HTMLElement, boolean>();
  const nav = h("nav", { class: "settings-nav" });
  const content = h("div", { class: "settings-content" });
  const accountsPane = h("div", { class: "settings-pane" });
  mountAccounts(accountsPane, store, controller);
  const modelsPane = h("div", { class: "settings-pane" });
  mountModelsSettings(modelsPane, store, controller);

  const dialog = h("div", { class: "settings-dialog", aria: { modal: "true", label: "Settings" } },
    h("aside", { class: "settings-sidebar" },
      h("div", { class: "settings-heading" }, h("h2", {}, "Settings")),
      nav,
    ),
    h("div", { class: "settings-main" },
      h("button", {
        class: "icon-button settings-close",
        title: "Close settings",
        aria: { label: "Close settings" },
        onClick: () => controller.closeSettings(),
      }, icon("x")),
      content,
    ),
  );
  dialog.setAttribute("role", "dialog");
  dialog.tabIndex = -1;
  const overlay = h("div", { class: "settings-overlay" }, dialog);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) controller.closeSettings();
  });
  // Nested account drawers and dropdowns own their keys first. Otherwise
  // Settings contains Tab focus, even if a pending control becomes disabled.
  document.addEventListener("keydown", (event) => {
    if (!store.get().settings.open || document.querySelector(".modal-backdrop, .popover")) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); controller.closeSettings();
    } else if (event.key === "Tab") {
      const controls = [...dialog.querySelectorAll<HTMLElement>("button, input, textarea, [tabindex='0']")]
        .filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  }, true);
  root.append(overlay);

  const general = renderGeneral();
  const about = renderAbout(store, controller);
  const pluginsPane = h("div", { class: "settings-pane" });
  store.watch((state) => state.enabledPlugins, (enabled) => replace(pluginsPane, ...renderPlugins(enabled, controller)));

  store.watch((state) => state.settings, (settings) => {
    overlay.hidden = !settings.open;
    if (settings.open && !wasOpen) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      // Inert siblings also keep assistive navigation out of the covered app.
      for (const sibling of root.parentElement?.children ?? []) {
        if (sibling instanceof HTMLElement && sibling !== root) { background.set(sibling, sibling.inert); sibling.inert = true; }
      }
    } else if (!settings.open && wasOpen) {
      for (const [element, inert] of background) element.inert = inert;
      background.clear();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    }
    wasOpen = settings.open;
    if (!settings.open) return;
    replace(nav, ...SECTIONS.map((section) => h("button", {
      class: section.id === settings.section ? "nav-item active" : "nav-item",
      aria: { current: section.id === settings.section ? "page" : "false" },
      onClick: () => controller.openSettings(section.id),
    },
      icon(section.icon, { className: "nav-icon" }),
      h("span", { class: "nav-title" }, section.title),
    )));
    const section = SECTIONS.find((candidate) => candidate.id === settings.section) ?? SECTIONS[0];
    if (section === undefined) return;
    if (section.id === "general") replace(content, general);
    else if (section.id === "accounts") replace(content, accountsPane);
    else if (section.id === "models") replace(content, modelsPane);
    else if (section.id === "plugins") replace(content, pluginsPane);
    else if (section.id === "shortcuts") replace(content, renderShortcuts());
    else if (section.id === "about") replace(content, about);
    else replace(content, general);
    // Move focus into the dialog so Escape and Tab work immediately. The
    // dialog itself takes focus, which avoids a focus ring on a nav item the
    // user did not choose.
    if (!dialog.contains(document.activeElement)) dialog.focus();
  });
}

function renderGeneral(): HTMLElement {
  const choices = new Map<ThemePreference, HTMLButtonElement>();
  const select = (preference: ThemePreference) => {
    applyTheme(preference);
    for (const [candidate, button] of choices) {
      button.classList.toggle("active", candidate === preference);
      button.setAttribute("aria-checked", String(candidate === preference));
      button.tabIndex = candidate === preference ? 0 : -1;
    }
  };
  const group = h("div", { class: "theme-choices", aria: { label: "Appearance" } });
  group.setAttribute("role", "radiogroup");
  for (const [preference, iconName, title, description] of THEMES) {
    const button = h("button", { class: `theme-choice theme-choice-${preference}`, onClick: () => select(preference) },
      h("span", { class: "theme-preview" }, h("span", {}), h("span", {}), h("span", {})),
      h("span", { class: "theme-choice-title" }, icon(iconName), title),
      h("span", { class: "theme-choice-description" }, description),
    );
    button.setAttribute("role", "radio");
    choices.set(preference, button);
    group.append(button);
  }
  select(loadTheme());

  const paletteChoices = new Map<ThemePalette, HTMLButtonElement>();
  const selectPalette = (palette: ThemePalette) => {
    applyPalette(palette);
    for (const [candidate, button] of paletteChoices) {
      button.classList.toggle("active", candidate === palette);
      button.setAttribute("aria-checked", String(candidate === palette));
      button.tabIndex = candidate === palette ? 0 : -1;
    }
  };
  const palettes = h("div", { class: "palette-choices", aria: { label: "Color palette" } });
  palettes.setAttribute("role", "radiogroup");
  for (const [palette, title] of PALETTES) {
    const button = h("button", { class: `theme-choice palette-choice-${palette}`, onClick: () => selectPalette(palette) },
      h("span", { class: "palette-preview", aria: { hidden: "true" } },
        h("span", { class: "palette-preview-light" }, h("span", {})),
        h("span", { class: "palette-preview-dark" }, h("span", {})),
      ),
      h("span", { class: "theme-choice-title" }, title),
    );
    button.setAttribute("role", "radio");
    paletteChoices.set(palette, button);
    palettes.append(button);
  }
  selectPalette(loadPalette());
  wireRadioKeys(group);
  wireRadioKeys(palettes);

  return h("div", { class: "settings-pane" },
    h("header", { class: "settings-pane-header" },
      h("h3", {}, "General"),
      h("p", {}, "Appearance and application preferences."),
    ),
    h("section", { class: "settings-group" },
      h("div", { class: "settings-group-head" },
        h("span", { class: "settings-group-title" }, "Appearance"),
        h("span", { class: "settings-group-description" }, "Stored on this device."),
      ),
      group,
    ),
    h("section", { class: "settings-group" },
      h("div", { class: "settings-group-head" },
        h("span", { class: "settings-group-title" }, "Color palette"),
        h("span", { class: "settings-group-description" }, "Every palette includes light and dark appearances."),
      ),
      palettes,
    ),
    h("p", { class: "settings-footnote" }, icon("info"), "Appearance is saved on this device. Closing the app asks you to stop any active runs."),
  );
}

/** Reference for shortcuts already handled by the composer, tools and shell. */
function renderShortcuts(): HTMLElement {
  const modifier = navigator.userAgent.includes("Macintosh") ? "⌘" : "Ctrl";
  const groups: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
    ["Conversation", [["Send message", "Enter"], ["Insert a new line", "Shift + Enter"], ["Stop the active run / close a menu", "Esc"], ["Open installed skills in an empty prompt", "/"]]],
    ["Tools", [["Save the current file", `${modifier} + S`], ["Focus the browser address", `${modifier} + L`], ["Navigate tool tabs", "← / →"], ["First / last tool tab", "Home / End"], ["Close the focused tool tab", "Delete"]]],
    ["Navigation", [["Resize a focused panel divider", "Arrow keys"], ["Reset a panel divider", "Double-click"], ["Reorder a project or session", "Alt + ↑ / ↓"], ["Move through controls", "Tab / Shift + Tab"]]],
  ];
  return h("div", { class: "settings-pane" },
    h("header", { class: "settings-pane-header" }, h("h3", {}, "Shortcuts"), h("p", {}, "Keep your hands on the keyboard. Tool shortcuts apply while that tool is focused.")),
    ...groups.map(([title, shortcuts]) => h("section", { class: "settings-group shortcut-group" },
      h("h4", { class: "settings-group-title" }, title),
      ...shortcuts.map(([description, keys]) => h("div", { class: "shortcut-row" }, h("span", {}, description), h("kbd", {}, keys))))),
  );
}

/** Local product information; connection diagnostics remain in Accounts. */
function renderAbout(store: Store, controller: Controller): HTMLElement {
  const hostStatus = h("div", { class: "settings-group-title", role: "status" });
  store.watch((state) => state.host, (host) => {
    const ready = host.status === "ready";
    replace(hostStatus, icon(ready ? "check-circle" : host.status === "connecting" ? "circle-notch" : "warning-circle", { className: host.status === "connecting" ? "spin" : "" }),
      ready ? "Execution host connected" : host.status === "connecting" ? "Connecting to execution host…" : "Execution host unavailable");
  });
  return h("div", { class: "settings-pane" },
    h("header", { class: "settings-pane-header" }, h("h3", {}, "About"), h("p", {}, "A focused workspace for thinking and code.")),
    h("section", { class: "settings-group about-card" },
      h("span", { class: "about-mark" }, icon("stack")),
      h("h4", {}, "thinking & code"),
      h("p", { class: "note" }, `Desktop coding workspace · Version ${__APP_VERSION__}`),
      h("p", {}, "Bring your provider accounts, work with local projects, and keep conversations, tools and project history together.")),
    h("section", { class: "settings-group" },
      hostStatus,
      h("p", { class: "note" }, "Projects and saved conversations are stored locally. Provider sign-in and execution use your connected accounts."),
      h("button", { class: "icon-button", type: "button", title: "Manage connections", aria: { label: "Manage connections" }, onClick: () => controller.openSettings("accounts") }, icon("plugs"))),
  );
}

/**
 * Plugin toggles govern optional open tools without creating tabs. The
 * launcher and + menu can enable a tool when the user chooses it. Only unfinished plugins carry the Preview label. These are
 * presentation preferences; hiding a panel does not terminate its resources.
 */
function renderPlugins(enabled: readonly string[], controller: Controller): Node[] {
  return [
    h("header", { class: "settings-pane-header" },
      h("h3", {}, "Plugins"),
      h("p", {}, "Open tools from the right panel’s list or + menu. Disabling a plugin hides its open tab. Tools keep their state while you switch tabs."),
    ),
    h("section", { class: "settings-group settings-list" },
      ...SURFACES.filter((surface) => surface.kind === "plugin" && !surface.preview).map((surface) => {
        const on = enabled.includes(surface.id);
        const toggle = h("button", {
          class: on ? "switch on" : "switch",
          aria: { checked: String(on), label: `Enable ${surface.title}` },
          onClick: () => controller.setPluginEnabled(surface.id, !on),
        }, h("span", { class: "switch-thumb" }));
        toggle.setAttribute("role", "switch");
        return h("div", { class: "settings-list-row" },
          h("span", { class: "icon-tile" }, icon(surface.icon)),
          h("span", { class: "settings-group-head" },
            h("span", { class: "settings-group-title" }, surface.title, surface.preview ? h("span", { class: "soon" }, "Preview") : null),
            h("span", { class: "settings-group-description" }, surface.description),
          ),
          toggle,
        );
      }),
    ),
  ];
}

/** Native radio-style arrow navigation without adding inactive choices to Tab. */
function wireRadioKeys(group: HTMLElement): void {
  group.addEventListener("keydown", (event) => {
    const choices = [...group.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
      : ["ArrowRight", "ArrowDown"].includes(event.key) ? (index + 1) % choices.length
        : ["ArrowLeft", "ArrowUp"].includes(event.key) ? (index + choices.length - 1) % choices.length : undefined;
    if (next === undefined) return;
    event.preventDefault(); choices[next]?.click(); choices[next]?.focus();
  });
}
