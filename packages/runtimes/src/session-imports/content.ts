/** Extract visible transcript content only; never decode hidden reasoning state. */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function visibleContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((raw) => {
    const block = record(raw);
    if (typeof block.text === "string") return block.text;
    if (block.type === "tool_result") return `Tool result: ${visibleContent(block.content) || JSON.stringify(block.content ?? null)}`;
    if (block.type === "tool_use") return `Tool ${String(block.name ?? "call")}: ${JSON.stringify(block.input ?? {})}`;
    if (block.type === "image" || block.type === "input_image") return "[Image from the original session; media was not imported]";
    if (block.type === "document") return "[Document from the original session; attachment was not imported]";
    return "";
  }).filter(Boolean).join("\n\n");
}

export function isoDate(value: unknown, fallback = new Date(0).toISOString()): string {
  const date = typeof value === "number" ? new Date(value) : typeof value === "string" ? new Date(value) : undefined;
  return date !== undefined && Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}
