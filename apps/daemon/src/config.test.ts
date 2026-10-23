import assert from "node:assert/strict";
import test from "node:test";

import { ConfigurationError, DEFAULT_PORT, isPubliclyBound, parseConfig } from "./config.js";

test("the defaults keep the daemon on loopback", () => {
  const config = parseConfig([]);
  assert.equal(config.host, "127.0.0.1", "a command surface this powerful must not default to a public bind");
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.printToken, false);
  assert.ok(config.tokenFile.endsWith("/daemon/token"), "the token lives under the data directory by default");
});

test("the token file follows an overridden data directory", () => {
  const config = parseConfig(["--data-directory", "/srv/rack"]);
  assert.equal(config.dataDirectory, "/srv/rack");
  assert.equal(config.tokenFile, "/srv/rack/daemon/token");

  const explicit = parseConfig(["--data-directory", "/srv/rack", "--token-file", "/run/secrets/token"]);
  assert.equal(explicit.tokenFile, "/run/secrets/token", "an explicit token file wins");
});

test("options are parsed and converted", () => {
  const config = parseConfig([
    "--host", "0.0.0.0",
    "--port", "9000",
    "--machine-id", "build-box",
    "--replay-buffer", "50",
    "--shutdown-timeout", "30",
    "--print-token",
  ]);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 9000);
  assert.equal(config.machineId, "build-box");
  assert.equal(config.replayBuffer, 50);
  assert.equal(config.shutdownTimeoutMs, 30_000, "the flag is seconds, the field is milliseconds");
  assert.equal(config.printToken, true);
});

test("an environment token is picked up and an empty one is ignored", () => {
  assert.equal(parseConfig([], { RACK_DAEMON_TOKEN: "abc" }).tokenFromEnvironment, "abc");
  assert.equal(parseConfig([], { RACK_DAEMON_TOKEN: "" }).tokenFromEnvironment, undefined);
  assert.equal(parseConfig([], {}).tokenFromEnvironment, undefined);
});

test("bad input fails loudly instead of falling back to a default", () => {
  // A mistyped flag that silently used the default data directory would
  // point a VM at the wrong records.
  assert.throws(() => parseConfig(["--data-dir", "/srv"]), ConfigurationError);
  assert.throws(() => parseConfig(["--port", "not-a-number"]), ConfigurationError);
  assert.throws(() => parseConfig(["--port", "70000"]), ConfigurationError);
  assert.throws(() => parseConfig(["--replay-buffer", "0"]), ConfigurationError);
  assert.throws(() => parseConfig(["--host"]), ConfigurationError, "a flag without its value is an error");
  assert.throws(() => parseConfig(["--host", "--port"]), ConfigurationError);
});

test("port 0 is allowed so a supervisor can let the system choose", () => {
  assert.equal(parseConfig(["--port", "0"]).port, 0);
});

test("public binds are recognised so the daemon can warn about them", () => {
  assert.equal(isPubliclyBound("127.0.0.1"), false);
  assert.equal(isPubliclyBound("::1"), false);
  assert.equal(isPubliclyBound("localhost"), false);
  assert.equal(isPubliclyBound("0.0.0.0"), true);
  assert.equal(isPubliclyBound("10.0.0.5"), true);
});
