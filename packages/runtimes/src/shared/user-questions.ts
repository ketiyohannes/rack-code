import type { UserQuestion } from "@rack/core/execution/types";

/** Native question parsing belongs at the adapter boundary. Reject malformed
 * prompts rather than silently picking an option or dropping a question.
 */
export function nativeQuestions(input: Record<string, unknown>, provider: "claude" | "codex"): readonly UserQuestion[] {
  if (!Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > 4) throw new Error("Invalid native question list.");
  const result = input.questions.map((raw: unknown, index): UserQuestion => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid native question.");
    const item = raw as Record<string, unknown>;
    if (typeof item.question !== "string" || item.question.trim() === "" || item.question.length > 20_000) throw new Error("Invalid question text.");
    const id = provider === "claude" ? `question-${index + 1}` : item.id;
    if (typeof id !== "string" || id.length === 0 || id.length > 500) throw new Error("Invalid question identity.");
    const choices = item.options ?? [];
    if (!Array.isArray(choices) || choices.length > 20) throw new Error("Invalid question options.");
    const options = choices.map((choice: unknown) => {
      if (typeof choice !== "object" || choice === null || !("label" in choice) || typeof choice.label !== "string" || choice.label.trim() === "") throw new Error("Invalid question option.");
      return { label: choice.label, ...("description" in choice && typeof choice.description === "string" ? { description: choice.description } : {}) };
    });
    if (new Set(options.map((option) => option.label)).size !== options.length) throw new Error("Duplicate question options.");
    return { id, question: item.question, ...(typeof item.header === "string" ? { header: item.header } : {}), options,
      multiSelect: provider === "claude" && item.multiSelect === true,
      allowCustom: provider === "claude" || item.isOther === true || options.length === 0,
      ...(item.isSecret === true ? { isSecret: true } : {}) };
  });
  if (new Set(result.map((question) => question.id)).size !== result.length ||
    (provider === "claude" && new Set(result.map((question) => question.question)).size !== result.length)) throw new Error("Duplicate native questions.");
  return result;
}
