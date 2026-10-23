/** Renderer-local retention helpers. Stable nodes preserve disclosure/focus
 * state; session-scoped subscriptions keep other conversations off this path. */
import type { RuntimeEvent } from "@rack/contracts";
import { applyEvent, EMPTY_TRANSCRIPT, type TranscriptState } from "./transcript.js";

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

/** Reorder/replace only changed children. Unlike replaceChildren, this leaves
 * unchanged mounted turns in place during a streaming update. */
export function reconcileChildren(parent: HTMLElement, nodes: readonly Node[]): void {
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor !== null) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
