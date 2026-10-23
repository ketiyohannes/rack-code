import type { RuntimeEvent } from "./types.js";
import { parseQuestionResponse, validateQuestionAnswers, QuestionAnswerError, type UserQuestion, type UserQuestionRequest, type UserQuestionResponse } from "./question-types.js";

interface PendingQuestion {
  readonly request: UserQuestionRequest;
  readonly resolve: (response: UserQuestionResponse | null) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

/** Owns unanswered questions for one run. Answers go only to the matching
 * native request. Cancellation settles waiters and secret answers never
 * enter journal/broadcast events; only the native callback receives them.
 */
export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>();
  private readonly settling = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly createId: () => string, private readonly record: (event: RuntimeEvent) => Promise<void>) {}

  async request(questions: readonly UserQuestion[], signal: AbortSignal): Promise<UserQuestionResponse | null> {
    if (this.closed || signal.aborted) return null;
    if (questions.length === 0 || questions.length > 4 || new Set(questions.map((question) => question.id)).size !== questions.length) {
      throw new Error("Invalid question request.");
    }
    const request: UserQuestionRequest = { id: this.createId(), questions };
    let resolve!: PendingQuestion["resolve"];
    let reject!: PendingQuestion["reject"];
    const completion = new Promise<UserQuestionResponse | null>((accept, fail) => { resolve = accept; reject = fail; });
    // A disconnect/cancellation may settle while the journal write is pending.
    void completion.catch(() => {});
    const abort = () => { void this.respond(request.id, null).catch(reject); };
    this.pending.set(request.id, { request, resolve, reject, cleanup: () => signal.removeEventListener("abort", abort) });
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.record({ type: "question_request", request });
    } catch (error) {
      this.pending.get(request.id)?.cleanup();
      this.pending.delete(request.id);
      throw error;
    }
    return completion;
  }

  async respond(id: string, input: UserQuestionResponse | null): Promise<void> {
    const pending = this.pending.get(id);
    if (pending === undefined) throw new QuestionAnswerError("This question is no longer pending.");
    const response = parseQuestionResponse(input);
    validateQuestionAnswers(pending.request, response);
    this.pending.delete(id);
    pending.cleanup();
    const safe = response === null ? null : { answers: Object.fromEntries(pending.request.questions.map((question) =>
      [question.id, question.isSecret ? ["[redacted]"] : response.answers[question.id]!])) };
    const settlement = (async () => {
      try {
        await this.record({ type: "question_resolved", requestId: id, response: safe });
        pending.resolve(response);
      } catch (error) { pending.reject(error); throw error; }
    })();
    this.settling.add(settlement);
    try { await settlement; } finally { this.settling.delete(settlement); }
  }

  async close(): Promise<void> {
    this.closed = true;
    const dismissals = [...this.pending.keys()].map((id) => this.respond(id, null));
    // Native cancellation can already be persisting a resolution after it
    // removes the pending entry. Drain it before execution closes its queue.
    const results = await Promise.allSettled([...dismissals, ...this.settling]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
