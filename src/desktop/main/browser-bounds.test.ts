import assert from "node:assert/strict";
import test from "node:test";
import { browserViewBounds } from "./browser-bounds.js";

test("embedded browser converts CSS rectangles to native coordinates at non-default zoom", () => {
  const rect = { x: 800, y: 100, width: 400, height: 600 };
  assert.deepEqual(browserViewBounds(rect, [1800, 1000], 1.25), { x: 1000, y: 125, width: 500, height: 750 });
  assert.deepEqual(browserViewBounds(rect, [1000, 700], 0.8), { x: 640, y: 80, width: 320, height: 480 });
  assert.deepEqual(browserViewBounds(rect, [1200, 800]), rect);
  assert.deepEqual(browserViewBounds({ x: 900, y: 600, width: 500, height: 400 }, [1200, 800], 1.25), { x: 1125, y: 750, width: 75, height: 50 });
});
