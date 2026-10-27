/**
 * Observation times of runtime events, as received by this renderer.
 *
 * A `RuntimeEvent` deliberately carries no timestamp: it is the normalized
 * provider event, and its time belongs to whoever observed it. The host
 * stamps each live event (`run.event.observedAt`, `ActiveRunView.observedAt`)
 * and the journal records `observedAt` for every persisted event. The
 * controller records those stamps here when it receives events, from all
 * three sources, and views that show durations read them back.
 *
 * Times are kept by event identity rather than in parallel arrays so every
 * existing `readonly RuntimeEvent[]` in the store keeps its type and its
 * append-only sharing (see `render-cache.ts`). Events are immutable objects
 * that live as long as the arrays holding them, so a `WeakMap` neither leaks
 * nor loses entries while a view can still render them.
 *
 * All stamps are host clock readings. Durations are differences between two
 * host stamps, never between a host stamp and this device's clock, so a
 * remote viewer with a skewed clock still sees correct durations.
 */
import type { RuntimeEvent } from "@rack/contracts/views";

const observed = new WeakMap<RuntimeEvent, number>();

/** Records when the host observed `event`. Invalid or absent stamps are ignored. */
export function recordObservedAt(event: RuntimeEvent, observedAt: string | undefined): void {
  if (observedAt === undefined) return;
  const time = Date.parse(observedAt);
  if (Number.isFinite(time)) observed.set(event, time);
}

/** Host observation time in epoch milliseconds, when one was recorded. */
export function observedAtOf(event: RuntimeEvent): number | undefined {
  return observed.get(event);
}
