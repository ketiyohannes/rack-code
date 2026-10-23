/**
 * Sequencing and replay buffer for the host's outbound event stream.
 *
 * A `HostApi` emits events through a single callback and has no notion of
 * who is listening. Remote controllers need two things that callback cannot
 * provide: a stable order they can checkpoint against, and a way to recover
 * the events they missed while a laptop lid was shut.
 *
 * `EventStream` sits between them. It stamps each event with a monotonic
 * sequence, fans it out to every attached subscriber, and keeps a bounded
 * tail so a reconnecting subscriber can be caught up without re-reading all
 * application state.
 *
 * The buffer is deliberately bounded and deliberately allowed to lose
 * events. Host events are a freshness signal rather than the source of truth
 * (see `@rack/contracts/events`), so a subscriber whose gap has already been
 * evicted is told the stream was `truncated` and re-reads state with the
 * ordinary read commands. Keeping the buffer small is therefore a memory
 * decision, not a correctness one: a run that emits tens of thousands of
 * deltas must not pin them all in a daemon that may be serving a 256 MB VM.
 */
import type { HostEvent } from "@rack/contracts/events";
import type { SequencedEvent } from "@rack/contracts/protocol";

/** Events retained for replay when the caller does not choose a size. */
export const DEFAULT_REPLAY_BUFFER = 1024;

export interface EventStreamOptions {
  /** How many of the most recent events stay replayable. */
  readonly bufferSize?: number;
}

/** Answer to a resume request. */
export type ReplayResult =
  /** The gap was buffered; `events` carries it in order. */
  | { readonly status: "replayed"; readonly events: readonly SequencedEvent[] }
  /** The gap is gone. The subscriber must re-read state. */
  | { readonly status: "truncated" };

export class EventStream {
  private readonly buffer: SequencedEvent[] = [];
  private readonly bufferSize: number;
  private readonly subscribers = new Set<(entry: SequencedEvent) => void>();
  /** Sequence the next published event will carry. Starts at 1 so that a
   * resume cursor of 0 unambiguously means "I have seen nothing". */
  private nextSequence = 1;

  constructor(options: EventStreamOptions = {}) {
    const size = options.bufferSize ?? DEFAULT_REPLAY_BUFFER;
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`The replay buffer must be a positive integer, received ${String(size)}.`);
    }
    this.bufferSize = size;
  }

  /** Sequence the next published event will carry. */
  get cursor(): number {
    return this.nextSequence;
  }

  /**
   * Stamps and fans out one event. A throwing subscriber must not stop the
   * others or the run that produced the event, so failures are contained:
   * a remote connection that dies mid-write is a transport problem, and the
   * host has already persisted the event to the journal by this point.
   */
  publish(event: HostEvent): SequencedEvent {
    const entry: SequencedEvent = { sequence: this.nextSequence++, event };
    this.buffer.push(entry);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        // Ignored on purpose: see the method comment.
      }
    }
    return entry;
  }

  /** Attaches a live subscriber; returns an unsubscribe function. */
  subscribe(listener: (entry: SequencedEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * Returns everything published after `sequence`, or reports truncation
   * when part of that range has already been evicted.
   *
   * A cursor from the future (a client resuming against a daemon that
   * restarted and reset its counter) is also truncation: the sequence
   * numbers refer to a stream that no longer exists.
   */
  since(sequence: number): ReplayResult {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= this.nextSequence) {
      return { status: "truncated" };
    }
    const oldest = this.buffer[0];
    if (oldest === undefined) {
      // Nothing buffered. Only a caller that is already up to date can be
      // satisfied; anything earlier was evicted or never retained.
      return sequence === this.nextSequence - 1 ? { status: "replayed", events: [] } : { status: "truncated" };
    }
    if (sequence + 1 < oldest.sequence) {
      return { status: "truncated" };
    }
    return { status: "replayed", events: this.buffer.filter((entry) => entry.sequence > sequence) };
  }
}
