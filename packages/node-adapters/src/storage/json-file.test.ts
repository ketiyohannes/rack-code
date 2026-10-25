import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DirectoryRuntimeContextResolver } from "@rack/runtimes/authentication/directory-runtime-context-resolver";
import { JsonAccountStore } from "./json-account-store.js";
import { JsonFileDocument } from "./json-file.js";

test("persists account metadata atomically without credential material", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-"));
  try {
    const path = join(directory, "accounts.json");
    const store = new JsonAccountStore(path);
    await store.save({
      id: "account-1",
      providerId: "claude",
      identity: { providerAccountId: "provider-1", email: "person@example.test" },
      credential: { id: "credential-1", providerId: "claude", method: "oauth" },
      runtimeContextId: "context-1",
      availability: "available",
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    });

    const content = await readFile(path, "utf8");
    assert.match(content, /credential-1/);
    assert.doesNotMatch(content, /secret|oauth-token-value/);

    const reloaded = new JsonAccountStore(path);
    assert.equal((await reloaded.get("account-1"))?.identity.email, "person@example.test");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates a private runtime directory for each context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-contexts-"));
  try {
    const resolver = new DirectoryRuntimeContextResolver(directory);
    const first = await resolver.resolve("account-one");
    const second = await resolver.resolve("account-two");
    assert.notEqual(first.directory, second.directory);
    const permissions = (await stat(first.directory)).mode & 0o777;
    assert.equal(permissions, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("projected JSON reads detach only the selected data and reflect subsequent writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rack-projected-json-"));
  try {
    const document = new JsonFileDocument(join(directory, "data.json"), {
      items: [{ id: "chosen", nested: { text: "original" } }, { id: "other", nested: { text: "unrelated" } }],
    });
    const selected = await document.select((value) => value.items.find((item) => item.id === "chosen"));
    selected!.nested.text = "client mutation";
    assert.equal((await document.select((value) => value.items[0]))?.nested.text, "original");
    await document.update((value) => ({ items: value.items.map((item) => item.id === "chosen" ? { ...item, nested: { text: "updated" } } : item) }));
    assert.equal((await document.select((value) => value.items[0]))?.nested.text, "updated");
    assert.equal((await document.read()).items[1]?.nested.text, "unrelated");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
