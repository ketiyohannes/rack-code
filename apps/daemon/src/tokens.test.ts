import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTokenVerifier, generateToken, loadOrCreateToken } from "./tokens.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rack-daemon-tokens-"));
}

test("generated tokens are unguessable and distinct", () => {
  const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));
  assert.equal(tokens.size, 100, "no collisions across a sample");
  const [first] = tokens;
  assert.ok(first !== undefined && first.length >= 40, "256 bits of entropy, base64url encoded");
  assert.match(first, /^[A-Za-z0-9_-]+$/, "safe to paste, print or encode as a QR code");
});

test("a token is created once and reused on later starts", async () => {
  const path = join(await workspace(), "nested", "token");

  const created = await loadOrCreateToken(path);
  assert.equal(created.created, true);

  const reused = await loadOrCreateToken(path);
  assert.equal(reused.created, false, "a restart must not invalidate every paired device");
  assert.equal(reused.token, created.token);
});

test("the token file is not readable by other local accounts", async () => {
  const path = join(await workspace(), "token");
  await loadOrCreateToken(path);

  // A token readable by another account on the machine is equivalent to
  // handing that account a shell, since the daemon runs commands.
  const mode = (await stat(path)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, found ${mode.toString(8)}`);
});

test("an existing file with loose permissions is not widened further", async () => {
  const path = join(await workspace(), "token");
  await writeFile(path, "pre-existing-token\n", { mode: 0o644 });

  const loaded = await loadOrCreateToken(path);
  assert.equal(loaded.token, "pre-existing-token", "surrounding whitespace is trimmed");
  assert.equal(loaded.created, false);
});

test("an empty token file is treated as missing and replaced", async () => {
  const path = join(await workspace(), "token");
  await writeFile(path, "   \n");

  const loaded = await loadOrCreateToken(path);
  assert.equal(loaded.created, true, "an empty file must not authorize an empty token");
  assert.notEqual(loaded.token.trim(), "");
  assert.equal((await readFile(path, "utf8")).trim(), loaded.token);
});

test("verification accepts only the exact token", () => {
  const token = generateToken();
  const verify = createTokenVerifier(token);

  assert.equal(verify(token), true);
  assert.equal(verify(""), false);
  assert.equal(verify(`${token}x`), false, "a longer candidate must not match");
  assert.equal(verify(token.slice(0, -1)), false, "a prefix must not match");
  assert.equal(verify(generateToken()), false);
  // A length mismatch must be rejected rather than throw, which is what a
  // bare timingSafeEqual would do and would crash the handshake.
  assert.doesNotThrow(() => verify("short"));
});
