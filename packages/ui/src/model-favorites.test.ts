import assert from "node:assert/strict";
import test from "node:test";
import type { ModelView } from "@rack/contracts";
import { modelKey } from "./components/model-settings.js";
import { favoriteModels, parseModelFavorites } from "./model-favorites.js";

const model: ModelView = { id: "shared", label: "Same label", providerId: "one", providerName: "One", runtimeId: "first", accountIds: ["account"] };

test("favorite storage rejects malformed values and deduplicates valid identities", () => {
  for (const value of [null, "broken", "null", "{}", "true"]) assert.deepEqual(parseModelFavorites(value), []);
  assert.deepEqual(parseModelFavorites('["one|first|shared",null,1,"","one|first|shared","offline|runtime|model"]'), [modelKey(model), "offline|runtime|model"]);
});

test("only starred available models appear, scoped by provider and runtime", () => {
  const anotherProvider = { ...model, providerId: "two" };
  const anotherRuntime = { ...model, runtimeId: "second" };
  const models = [anotherProvider, model, anotherRuntime];
  assert.deepEqual(favoriteModels(models, []), []);
  assert.deepEqual(favoriteModels(models, [modelKey(model)]), [model]);
  assert.deepEqual(favoriteModels(models, [modelKey(anotherRuntime), modelKey(anotherProvider)]), [anotherProvider, anotherRuntime]);
  assert.deepEqual(favoriteModels(models, ["unavailable"]), []);
  const favorites = [modelKey(model)];
  assert.deepEqual(favoriteModels([], favorites), []);
  assert.deepEqual(favoriteModels([{ ...model, label: "Renamed", accountIds: ["reconnected"] }], favorites).map(modelKey), favorites);
  assert.deepEqual(favorites, [modelKey(model)], "catalog changes do not discard saved favorites");
});
