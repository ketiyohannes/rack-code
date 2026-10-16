/**
 * Provider-neutral presentation of command, file, search and integration tools.
 * Known field shapes get meaningful summaries; unknown arguments/results stay
 * available as structured data. These values are display-only, never executed.
 */
import type { TranscriptItem } from "../transcript.js";

export interface ToolSection { readonly label: string; readonly text: string; readonly format: "code" | "diff" | "text" | "json" }
export interface ToolPresentation {
  readonly title: string;
  readonly subtitle?: string;
  readonly icon: "terminal-window" | "files" | "pencil-simple" | "globe" | "wrench";
  readonly status: "Running" | "Completed" | "No matches" | "Failed" | "Stopped" | "Incomplete";
  readonly duration?: string;
  readonly exitCode?: number;
  readonly sections: readonly ToolSection[];
  /** File or folder the tool acted on, when there is exactly one; clickable in the UI. */
  readonly path?: string;
}

export function presentTool(item: Extract<TranscriptItem, { kind: "tool" }>, active: boolean): ToolPresentation {
  const outer = object(item.input);
  const input = typeof outer.input === "object" ? object(outer.input) : outer;
  const output = object(item.output);
  const name = item.tool.toLowerCase();
  const command = string(input.command) ?? string(input.cmd);
  const path = string(input.file_path) ?? string(input.path) ?? string(input.filePath);
  const changes = Array.isArray(output.changes) ? output.changes : Array.isArray(input.changes) ? input.changes : [];
  const query = string(input.query) ?? string(input.pattern) ?? string(input.url);
  const title = command !== undefined ? "Run command" : changes.length > 0 ? `Update ${changes.length === 1 ? "file" : `${changes.length} files`}`
    : path !== undefined && /read|view/.test(name) ? "Read file"
    : path !== undefined && /write|edit|patch/.test(name) ? "Edit file"
    : query !== undefined && /search|grep|glob|fetch|browse/.test(name) ? "Search"
    : humanize(string(input.tool) ?? item.tool);
  const subtitle = command ?? path ?? (changes.length > 0 ? changes.map((change) => string(object(change).path) ?? "file").join(", ") : query);
  const exitCode = number(output.exitCode) ?? number(output.exit_code);
  const isError = item.isError === true || (exitCode !== undefined && exitCode !== 0)
    || output.status === "failed" || output.status === "declined" || output.is_error === true;
  const stopped = ["interrupted", "cancelled", "canceled"].includes(String(output.status));
  const noMatches = command !== undefined && item.hasOutput && exitCode === 1
    && !stopped && output.status !== "declined"
    && isEmptyRipgrepResult(command, output);
  const sections: ToolSection[] = [];
  if (command !== undefined) {
    sections.push({ label: "Command", text: command, format: "code" });
    const cwd = string(input.cwd);
    if (cwd !== undefined) sections.push({ label: "Directory", text: cwd, format: "text" });
  } else if (changes.length === 0) sections.push({ label: "Arguments", text: formatValue(item.input), format: "json" });
  for (const raw of changes) {
    const change = object(raw);
    sections.push({ label: string(change.path) ?? "File change", text: string(change.diff) ?? formatValue(change), format: string(change.diff) === undefined ? "json" : "diff" });
  }
  if (item.hasOutput) {
    const text = string(output.aggregatedOutput) ?? string(output.stdout) ?? string(output.output)
      ?? textContent(output.content ?? object(output.result).content ?? item.output);
    if (text !== "") sections.push({ label: "Output", text, format: command === undefined ? "text" : "code" });
    else if (command !== undefined) sections.push({ label: "Output", text: noMatches ? "No matches" : "No output", format: "text" });
    else if (changes.length === 0 && command === undefined) sections.push({ label: "Result", text: formatValue(item.output), format: "json" });
    const error = output.error ?? output.stderr;
    if (error !== undefined && error !== null && error !== "") sections.push({ label: "Error", text: formatValue(error), format: "text" });
  }
  const durationMs = number(output.durationMs) ?? number(output.duration_ms);
  return { title, ...(subtitle === undefined ? {} : { subtitle }),
    ...(command === undefined && changes.length === 0 && path !== undefined ? { path } : changes.length === 1 && string(object(changes[0]).path) !== undefined ? { path: string(object(changes[0]).path)! } : {}),
    icon: command !== undefined ? "terminal-window" : changes.length > 0 ? "pencil-simple" : path !== undefined ? "files" : query !== undefined ? "globe" : "wrench",
    status: item.finished ? noMatches ? "No matches" : isError ? "Failed" : stopped ? "Stopped" : "Completed" : active ? "Running" : "Incomplete",
    ...(durationMs === undefined ? {} : { duration: durationMs < 1000 ? `${Math.round(durationMs)} ms` : `${(durationMs / 1000).toFixed(1)} s` }),
    ...(exitCode === undefined ? {} : { exitCode }), sections };
}

/** A display-only interpretation of ripgrep's documented no-match exit status.
 * Require an explicit empty output and a single recognizable invocation. Shell
 * batches, pipelines, substitutions and diagnostics remain failures because a
 * batch's status/output cannot establish which individual operation failed.
 * Never alter the journal, provider result, exit code or execution outcome.
 */
function isEmptyRipgrepResult(command: string, output: Record<string, unknown>): boolean {
  const captured = [output.aggregatedOutput, output.stdout, output.output];
  if (!captured.some((value) => typeof value === "string")
    || captured.some((value) => value !== undefined && (typeof value !== "string" || value.trim() !== ""))
    || [output.stderr, output.error].some((value) => value !== undefined && value !== null && value !== "")
    || output.content !== undefined || output.result !== undefined) return false;
  let invocation = command.trim();
  // Providers commonly show the shell executable around a simple search.
  const wrapped = invocation.match(/^(?:"[^"\r\n]*[\\/](?:powershell|pwsh)(?:\.exe)?"|(?:powershell|pwsh)(?:\.exe)?)\s+-Command\s+"([^"\r\n]*)"$/i)
    ?? invocation.match(/^(?:\/(?:[^\s]+\/)*(?:bash|zsh|sh)|bash|zsh|sh)\s+-(?:l?c)\s+(['"])(.*?)\1$/);
  if (wrapped) invocation = wrapped.length === 3 ? wrapped[2]! : wrapped[1]!;
  // Conservative even inside quotes: false negatives are preferable to hiding
  // a real error. More complex commands need structured per-command outcomes.
  if (/[;&|<>`$\r\n]/.test(invocation)) return false;
  return /^(?:rg(?:\.exe)?|"[^"\r\n]*[\\/]rg(?:\.exe)?"|(?:[^\s"']+[\\/])+rg(?:\.exe)?)\s+\S/i.test(invocation);
}

/** Imported native activities keep their provenance while using the same readable layout. */
export function importedTool(content: string): Extract<TranscriptItem, { kind: "tool" }> {
  let value: unknown = content;
  try { value = JSON.parse(content) as unknown; } catch { /* Plain-text history remains readable. */ }
  const native = object(value);
  const type = string(native.type) ?? "Imported activity";
  // A recorded snapshot is not proof that an unfinished external action
  // completed. Preserve explicit in-progress/failed status when provided.
  const finished = native.status !== "inProgress" && native.status !== "running";
  return { kind: "tool", tool: type, input: native, output: value, hasOutput: true, finished,
    isError: native.status === "failed" || native.status === "declined" || native.success === false || native.is_error === true };
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "Not provided";
  return JSON.stringify(value, null, 2) ?? String(value);
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => typeof entry === "string" ? entry : string(object(entry).text) ?? string(object(entry).content) ?? "").filter(Boolean).join("\n");
}
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function humanize(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_/]+/g, " ").replace(/^./, (character) => character.toUpperCase()); }
