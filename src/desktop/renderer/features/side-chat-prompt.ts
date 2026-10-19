/**
 * Pure prompt helpers for side chats (no DOM), shared by the panel and tests.
 *
 * A side-chat prompt is the user's text, then `CONTEXT_MARKER`, then hidden
 * context. The panel displays only the text before the marker.
 */

/** Separates the user's visible text from Rack-supplied context inside a prompt. */
export const CONTEXT_MARKER = "\n\n<<<rack-side-chat-context>>>\n";
/** Upper bound for hidden context; `runs.start` accepts 200,000 characters in total. */
export const MAX_CONTEXT_CHARS = 60_000;

/** The text the user typed: everything before the context marker. */
export function visiblePrompt(prompt: string): string {
  const index = prompt.indexOf(CONTEXT_MARKER);
  return index < 0 ? prompt : prompt.slice(0, index);
}

/** Bounds context to MAX_CONTEXT_CHARS and says so, rather than silently cutting. */
export function boundContext(text: string): string {
  return text.length <= MAX_CONTEXT_CHARS ? text
    : `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[Context shortened by Rack to ${MAX_CONTEXT_CHARS.toLocaleString("en-US")} characters.]`;
}

/** Combines the user's text with optional hidden context. */
export function sideChatPrompt(text: string, context: string | undefined): string {
  return context ? `${text}${CONTEXT_MARKER}${boundContext(context)}` : text;
}
