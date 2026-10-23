/**
 * Desktop renderer bootstrap.
 *
 * In the Electron app the host is a sibling process reached through the
 * preload bridge, so connecting takes no configuration and cannot fail
 * independently of the window. That makes this file very small: build the
 * bridge-backed client and hand it to `mountApp`, which contains the
 * interface itself and is shared with `apps/web`.
 */
import { createHostClient } from "@rack/client";

import { mountApp, requireRoot } from "./mount.js";

mountApp({
  root: requireRoot(),
  host: createHostClient(),
  params: new URLSearchParams(window.location.search),
});
