/** Renderer-local retention helpers. Stable nodes preserve disclosure/focus
 * state; session-scoped subscriptions keep other conversations off this path. */
import type { RuntimeEvent } from "@rack/contracts";
import { applyEvent, EMPTY_TRANSCRIPT, type TranscriptState } from "./transcript.js";
import { applyTimedEvent, EMPTY_TURN, type TurnActivity } from "./features/turn-activity.js";
import { observedAtOf } from "./event-times.js";

/** One fold per run. Append-only controller arrays share their existing event
 * objects; a replaced snapshot or shortened history starts a fresh fold. */
export class TranscriptCache {
  private readonly entries = new Map<string, { events: readonly RuntimeEvent[]; state: TranscriptState }>();
  fold(id: string, events: readonly RuntimeEvent[]): TranscriptState {
    const previous = this.entries.get(id);
    if (previous?.events === events) return previous.state;
    const extendsPrevious = previous !== undefined && events.length >= previous.events.length &&
      (previous.events.length === 0 || (events[0] === previous.events[0] && events[previous.events.length - 1] === previous.events.at(-1)));
    let state = extendsPrevious ? previous.state : EMPTY_TRANSCRIPT;
    for (let i = extendsPrevious ? previous.events.length : 0; i < events.length; i++) state = applyEvent(state, events[i]!);
    this.entries.set(id, { events, state });
    return state;
  }
  clear(): void { this.entries.clear(); }
}

/**
 * Turn-activity folds per run, extended incrementally like `TranscriptCache`.
 * Observation times are read from `event-times.ts`, where the controller
 * records them before an event reaches the store.
 */
export class TurnActivityCache {
  private readonly entries = new Map<string, { events: readonly RuntimeEvent[]; state: TurnActivity }>();
  fold(id: string, events: readonly RuntimeEvent[]): TurnActivity {
    const previous = this.entries.get(id);
    if (previous?.events === events) return previous.state;
    const extendsPrevious = previous !== undefined && events.length >= previous.events.length &&
      (previous.events.length === 0 || (events[0] === previous.events[0] && events[previous.events.length - 1] === previous.events.at(-1)));
    let state = extendsPrevious ? previous.state : EMPTY_TURN;
    for (let i = extendsPrevious ? previous.events.length : 0; i < events.length; i++) state = applyTimedEvent(state, events[i]!, observedAtOf(events[i]!));
    this.entries.set(id, { events, state });
    return state;
  }
  clear(): void { this.entries.clear(); }
}

/**
 * Reorder/replace only changed children. Unlike replaceChildren, this leaves
 * unchanged mounted nodes in place during a streaming update.
 *
 * Stale nodes in front of a retained node are removed rather than the
 * retained node being moved past them: moving a node detaches it, which
 * restarts its CSS animations and drops running transitions (tool group
 * cards rely on staying attached while a reply streams around them).
 */
export function reconcileChildren(parent: HTMLElement, nodes: readonly Node[]): void {
  const wanted = new Set(nodes);
  let cursor = parent.firstChild;
  for (const node of nodes) {
    while (cursor !== null && cursor !== node && !wanted.has(cursor)) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor !== null) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
