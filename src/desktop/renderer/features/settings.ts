/**
 * Settings overlay: a full-window dialog with section navigation.
 *
 * Implemented sections: General (appearance), Accounts (account
 * management, which also hosts re-authentication), Models (star favorites), and Plugins (enable
 * right-panel surfaces; Timeline, Terminal, Browser and Files are functional).
 * The remaining sections are placeholders that name
 * planned areas without offering behavior.
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

interface SectionInfo {
  readonly id: SettingsSection;
  readonly title: string;
  readonly icon: IconName;
  /** Placeholder description; absent for implemented sections. */
  readonly planned?: string;
}

const SECTIONS: readonly SectionInfo[] = [
  { id: "general", title: "General", icon: "sliders-horizontal" },
  { id: "accounts", title: "Accounts", icon: "user-circle" },
  { id: "models", title: "Models", icon: "star" },
  { id: "permissions", title: "Permissions", icon: "shield", planned: "Default permission mode for new runs and per-project overrides." },
  { id: "plugins", title: "Plugins", icon: "puzzle-piece" },
  { id: "shortcuts", title: "Shortcuts", icon: "keyboard", planned: "View and customize keyboard shortcuts." },
  { id: "notifications", title: "Notifications", icon: "bell-simple", planned: "Choose when to be notified about approvals and finished runs." },
  { id: "about", title: "About", icon: "info", planned: "Version, updates, and diagnostics." },
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
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.stopPropagation(); controller.closeSettings(); }
  });
  root.append(overlay);

  const general = renderGeneral();
  const pluginsPane = h("div", { class: "settings-pane" });
  store.watch((state) => state.enabledPlugins, (enabled) => replace(pluginsPane, ...renderPlugins(enabled, controller)));

  store.watch((state) => state.settings, (settings) => {
    overlay.hidden = !settings.open;
    if (!settings.open) return;
    replace(nav, ...SECTIONS.map((section) => h("button", {
      class: section.id === settings.section ? "nav-item active" : "nav-item",
      onClick: () => controller.openSettings(section.id),
    },
      icon(section.icon, { className: "nav-icon" }),
      h("span", { class: "nav-title" }, section.title),
      section.planned === undefined ? null : h("span", { class: "soon" }, "Soon"),
    )));
    const section = SECTIONS.find((candidate) => candidate.id === settings.section) ?? SECTIONS[0];
    if (section === undefined) return;
    if (section.id === "general") replace(content, general);
    else if (section.id === "accounts") replace(content, accountsPane);
    else if (section.id === "models") replace(content, modelsPane);
    else if (section.id === "plugins") replace(content, pluginsPane);
    else replace(content, renderPlaceholder(section));
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
    placeholderRow("Startup", "Choose what opens when the app starts."),
    placeholderRow("Exit behavior", "Background mode and stop-on-exit options."),
  );
}

function placeholderRow(title: string, description: string): HTMLElement {
  return h("section", { class: "settings-group settings-row" },
    h("div", { class: "settings-group-head" },
      h("span", { class: "settings-group-title" }, title),
      h("span", { class: "settings-group-description" }, description),
    ),
    h("span", { class: "soon" }, "Soon"),
  );
}

function renderPlaceholder(section: SectionInfo): HTMLElement {
  return h("div", { class: "settings-pane" },
    h("header", { class: "settings-pane-header" },
      h("h3", {}, section.title),
      h("p", {}, section.planned ?? ""),
    ),
    h("div", { class: "empty-card empty-card-large" },
      h("span", { class: "placeholder-icon" }, icon(section.icon)),
      h("span", { class: "placeholder-title" }, "Not available yet"),
      h("span", { class: "placeholder-text" }, "This section is reserved for a future release."),
    ),
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
      h("p", {}, "Open tools from the right panel’s list or + menu. Disabling a plugin hides its open tab. Plugins marked Preview have no functionality yet."),
    ),
    h("section", { class: "settings-group settings-list" },
      ...SURFACES.filter((surface) => surface.kind === "plugin").map((surface) => {
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
