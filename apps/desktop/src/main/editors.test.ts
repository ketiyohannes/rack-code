import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopEditors, discoverEditors } from "./editors.js";

test("editor discovery exposes only installed catalog apps and resolves user installations", async () => {
  const installed = new Set(["/Applications/Visual Studio Code.app", "/users/fixture/Applications/Cursor.app", "/Applications/Zed.app"]);
  const environment = { platform: "darwin" as const, home: "/users/fixture", env: {} };
  const catalog = await discoverEditors(environment, async (path) => installed.has(path));
  assert.deepEqual(catalog.map((entry) => entry.id), ["vscode", "cursor", "zed"]);
  assert.deepEqual(await new DesktopEditors({ environment, exists: async (path) => installed.has(path) }).list(), [
    { id: "vscode", label: "Visual Studio Code" }, { id: "cursor", label: "Cursor" }, { id: "zed", label: "Zed" },
  ]);
});

test("opening in an editor passes literal paths and rejects forged IDs, missing files and invalid choices", async () => {
  const root = await mkdtemp(join(tmpdir(), "rack-editors-"));
  const launches: string[][] = [];
  try {
    const file = join(root, "report $(touch marker) 'quoted'.py"); await writeFile(file, "print('read as text')");
    const editors = new DesktopEditors({ environment: { platform: "darwin", home: "/users/fixture", env: {} },
      exists: async (path) => ["/Applications/Cursor.app", "/Applications/Other Editor.app"].includes(path),
      launch: async (application, path) => { launches.push([application, path]); },
    });
    assert.equal(await editors.open({ editorId: "cursor", path: `${file}:12:3` }), "opened");
    assert.deepEqual(launches, [["/Applications/Cursor.app", file]]);
    assert.equal(await editors.open({ editorId: "/bin/sh", path: file }), "unavailable");
    assert.equal(await editors.open({ editorId: "cursor", path: "missing", base: root }), "missing");
    assert.equal(await editors.open({ editorId: "cursor", path: "relative.py" }), "invalid");
    assert.equal(await editors.open({ editorId: "choose", path: file }, async () => undefined), "cancelled");
    assert.equal(await editors.open({ editorId: "choose", path: file }, async () => "/bin/sh"), "invalid");
    assert.equal(await editors.open({ editorId: "choose", path: ".", base: root }, async () => "/Applications/Other Editor.app"), "opened");
    assert.deepEqual(launches[1], ["/Applications/Other Editor.app", root]);
    assert.equal(launches.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Linux discovery resolves installed editor binaries without shell interpolation", async () => {
  const catalog = await discoverEditors({ platform: "linux", home: "/home/fixture", env: { PATH: "/usr/bin:/opt/editor/bin" } }, async (path, directory) => !directory && ["/opt/editor/bin/code", "/usr/bin/cursor"].includes(path));
  assert.deepEqual(catalog.map((entry) => [entry.id, entry.application]), [["vscode", "/opt/editor/bin/code"], ["cursor", "/usr/bin/cursor"]]);
});
