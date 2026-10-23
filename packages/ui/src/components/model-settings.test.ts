import assert from "node:assert/strict";
import test from "node:test";
import type { ModelView } from "@rack/contracts";
import { effortStops, fastOptions, modelKey, PROVIDER_DEFAULT, selectedEffort, selectedSpeed } from "./model-settings.js";

const model: ModelView = { id: "model", providerId: "any-provider", runtimeId: "runtime", providerName: "Provider", label: "Model", accountIds: [],
  reasoningEfforts: [{ id: "low" }, { id: "high" }, { id: "provider-level", description: "Custom level" }], defaultReasoningEffort: "high",
  speeds: [{ id: "regular-tier", label: "Standard", fast: false }, { id: "accelerated-tier", label: "Fast", fast: true }], defaultSpeed: "regular-tier" };

test("reasoning slider follows catalog order and rejects unsupported saved levels", () => {
  assert.deepEqual(effortStops(model).map((stop) => stop.id), ["low", "high", "provider-level"]);
  assert.equal(effortStops(model)[2]?.label, "provider-level");
  assert.equal(effortStops(model)[2]?.description, "Custom level");
  assert.equal(selectedEffort(model, "low"), "low");
  assert.equal(selectedEffort(model, "max"), "high");
  assert.equal(selectedEffort({ ...model, reasoningEfforts: [] }, "high"), undefined);
});

test("unknown provider defaults retain a send-nothing slider stop", () => {
  const entry = { ...model, defaultReasoningEffort: "unreported-level" };
  assert.equal(effortStops(entry)[0]?.id, PROVIDER_DEFAULT);
  assert.equal(selectedEffort(entry, undefined), PROVIDER_DEFAULT);
  assert.equal(selectedEffort(entry, "high"), "high");
  assert.equal(selectedEffort(model, PROVIDER_DEFAULT), "high");
});

test("Fast uses adapter mappings across providers and migrates valid legacy choices", () => {
  assert.equal(selectedSpeed(model, true), "accelerated-tier");
  assert.equal(selectedSpeed(model, false), "regular-tier");
  assert.equal(selectedSpeed(model, undefined, "accelerated-tier"), "accelerated-tier");
  assert.equal(selectedSpeed(model, undefined, "another-provider-speed"), "regular-tier");
  assert.equal(selectedSpeed({ ...model, defaultSpeed: "accelerated-tier" }, undefined), "accelerated-tier");
  assert.equal(selectedSpeed({ ...model, defaultSpeed: "accelerated-tier" }, false), "regular-tier");
  assert.notEqual(modelKey(model), modelKey({ ...model, providerId: "another-provider" }));
});

test("a Fast tag cannot guess the meaning of arbitrary or incomplete speed catalogs", () => {
  const unknown = { ...model, speeds: [{ id: "fast", label: "Fast" }, { id: "standard", label: "Standard" }] };
  assert.equal(fastOptions(unknown), undefined);
  assert.equal(selectedSpeed(unknown, true), undefined);
  assert.equal(fastOptions({ ...model, speeds: [model.speeds![1]!] }), undefined);
  assert.equal(selectedSpeed({ ...model, speeds: [] }, true), undefined);
});
