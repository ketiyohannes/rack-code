/**
 * Shared startup sequence for every process that hosts Rack.
 *
 * Composition is only half of starting a host. The other half is recovering
 * from however the previous process ended, and its order matters:
 *
 * 0. adopt records written under the product's former name, before any
 *    store opens a file (see `@rack/node-adapters/storage/data-directory`);
 * 1. compose the application and wrap it in a `HostApi`;
 * 2. run `execution.initialize()` **to completion** before any client can
 *    issue a command. It marks runs that were interrupted mid-flight as
 *    `unknown` and releases writer locks their processes no longer hold.
 *    Serving queries first would hand clients stale `running` statuses and
 *    let a new run collide with a lock nobody owns;
 * 3. start Timeline's project tracking in the background. It is an optional
 *    feature, and a failure to begin recording must not keep the host from
 *    coming up, so its rejection is swallowed rather than propagated.
 *
 * The desktop utility process and the daemon both need exactly this, which
 * is why it lives here rather than being written twice and drifting.
 */
import type { HostEvent } from "@rack/contracts/events";
import { adoptLegacyDataDirectory } from "@rack/node-adapters/storage/data-directory";

import { createApplication, type Application, type CreateApplicationOptions } from "./composition/application.js";
import { HostApi } from "./host-api.js";

export interface StartedHost {
  readonly application: Application;
  readonly api: HostApi;
}

export async function startHost(
  options: CreateApplicationOptions,
  emit: (event: HostEvent) => void,
): Promise<StartedHost> {
  // An explicit directory is the caller's choice and is never relocated.
  const dataDirectory = options.dataDirectory ?? adoptLegacyDataDirectory();
  const application = createApplication({ ...options, dataDirectory });
  const api = new HostApi(application, emit);
  await application.execution.initialize();
  // Existing projects start recording without needing a session or import
  // action; see the note above on why this failure is not fatal.
  void Promise.resolve(application.timeline?.startProjectTracking()).catch(() => {});
  return { application, api };
}
