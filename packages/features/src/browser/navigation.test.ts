import assert from "node:assert/strict";
import test from "node:test";
import { browserAddress } from "./navigation.js";

test("browser omnibox navigates addresses and loopback hosts, searches prose, and rejects privileged URLs", () => {
  assert.equal(browserAddress(" example.com/docs "), "https://example.com/docs");
  assert.equal(browserAddress("http://localhost:4311/page"), "http://localhost:4311/page");
  assert.equal(browserAddress("localhost:4311/page"), "http://localhost:4311/page");
  assert.equal(browserAddress("browser research & examples"), "https://www.google.com/search?q=browser%20research%20%26%20examples");
  for (const input of ["", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,bad", "https://user:password@example.com"]) assert.throws(() => browserAddress(input));
});
