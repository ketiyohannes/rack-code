/** Invalid/stale answers are input errors, never authorization decisions. */
export class QuestionAnswerError extends Error {
  constructor(message: string) { super(message); this.name = "QuestionAnswerError"; }
}

/** Provider-neutral questions. Native tool names and answer encodings stay in adapters. */
export interface UserQuestion {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect: boolean;
  readonly allowCustom: boolean;
  readonly isSecret?: boolean;
}

export interface UserQuestionRequest {
  readonly id: string;
  readonly questions: readonly UserQuestion[];
}

export interface UserQuestionResponse {
  readonly answers: Readonly<Record<string, readonly string[]>>;
}

/** Bound transport input before matching it against a host-owned pending request. */
export function parseQuestionResponse(value: unknown): UserQuestionResponse | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || value === null ||
    Object.keys(value).length !== 1 || !("answers" in value)) throw new QuestionAnswerError("Expected question answers or cancellation.");
  const answers = value.answers;
  if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new QuestionAnswerError("Expected an answer record.");
  const entries = Object.entries(answers);
  if (entries.length > 4 || entries.some(([id, selected]) => id.length === 0 || id.length > 500 ||
    !Array.isArray(selected) || selected.length > 21 || selected.some((answer) => typeof answer !== "string" || answer.length > 10_000 || answer.trim() === ""))) {
    throw new QuestionAnswerError("Invalid question answer shape.");
  }
  return { answers: Object.fromEntries(entries.map(([id, selected]) => [id, [...selected]])) };
}

/** Never infer answers, choose defaults, or treat a question as permission to act. */
export function validateQuestionAnswers(request: UserQuestionRequest, response: UserQuestionResponse | null): void {
  if (response === null) return;
  const keys = Object.keys(response.answers);
  if (keys.length !== request.questions.length || keys.some((id) => !request.questions.some((question) => question.id === id))) {
    throw new QuestionAnswerError("Answer every question in this request.");
  }
  for (const question of request.questions) {
    const answers = response.answers[question.id];
    if (answers === undefined || answers.length === 0 || (!question.multiSelect && answers.length !== 1) ||
      new Set(answers).size !== answers.length || (!question.allowCustom && answers.some((answer) => !question.options.some((option) => option.label === answer)))) {
      throw new QuestionAnswerError("The answer does not match the pending question.");
    }
  }
}
