/** Settings owns the full catalog; the composer receives only starred entries. */
import type { Controller } from "../controller.js";
import { modelKey } from "../components/model-settings.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import type { Store } from "../store.js";

export function mountModelsSettings(root: HTMLElement, store: Store, controller: Controller): void {
  const summary = h("p", { class: "settings-group-description", aria: { live: "polite" } });
  const notices = h("div", { class: "settings-model-notices" });
  const list = h("div", { class: "settings-model-list" });
  root.append(
    h("header", { class: "settings-pane-header" }, h("h3", {}, "Models"),
      h("p", {}, "Star the models you want in the model picker.")),
    summary, notices, list,
  );
  store.watch((state) => [state.models, state.modelsLoading, state.favoriteModelKeys, state.modelCatalogFailures, state.host], (_slice, state) => {
    const focused = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset["modelKey"] : undefined;
    const favorites = new Set(state.favoriteModelKeys);
    const known = new Set(state.models.map(modelKey));
    const unavailable = state.favoriteModelKeys.filter((key) => !known.has(key)).length;
    summary.textContent = `${favorites.size} model${favorites.size === 1 ? "" : "s"} starred · Saved on this device`;
    replace(notices,
      unavailable === 0 ? null : h("p", { class: "form-note" }, `${unavailable} starred model${unavailable === 1 ? " is" : "s are"} currently unavailable. Favorites are kept for when they return.`),
      state.modelCatalogFailures.length === 0 ? null : h("p", { class: "form-note" }, "Some accounts could not load their models. Check the connected accounts."),
    );
    if (state.models.length === 0) {
      replace(list, h("div", { class: "empty-card empty-card-large" }, icon("star"),
        h("span", {}, (state.modelsLoading || state.host.status === "connecting") ? "Loading models…" : "No models available. Connect a provider account to choose favorites."),
        h("button", { class: "icon-button", type: "button", title: "Manage accounts", aria: { label: "Manage accounts" }, onClick: () => controller.openSettings("accounts") }, icon("user-circle"))));
      return;
    }
    const providers = [...new Set(state.models.map((model) => model.providerId))];
    replace(list, ...providers.map((providerId) => {
      const models = state.models.filter((model) => model.providerId === providerId);
      return h("section", { class: "settings-group settings-model-group", aria: { label: models[0]!.providerName } },
        h("h4", { class: "settings-model-provider" }, models[0]!.providerName),
        ...models.map((model) => {
          const key = modelKey(model);
          const starred = favorites.has(key);
          const label = `${starred ? "Unstar" : "Star"} ${model.label} (${model.providerName})`;
          return h("div", { class: "settings-model-row" },
            h("div", { class: "settings-model-info" }, h("span", { class: "settings-model-name" }, model.label),
              model.description ? h("span", { class: "settings-group-description" }, model.description) : null),
            h("button", { class: "icon-button model-favorite", type: "button", title: label,
              aria: { label, pressed: String(starred) }, data: { modelKey: key },
              onClick: () => controller.setModelFavorite(key, !starred),
            }, icon(starred ? "star-fill" : "star")));
        }));
    }));
    // Toggling a star replaces its row. Restore focus by identity rather than
    // by label (Star becomes Unstar), keeping keyboard selection continuous.
    if (focused !== undefined) [...list.querySelectorAll<HTMLButtonElement>(".model-favorite")].find((button) => button.dataset["modelKey"] === focused)?.focus();
  });
}
