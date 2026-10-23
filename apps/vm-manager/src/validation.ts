/**
 * Request validation primitives.
 *
 * Request bodies arrive as `unknown` from the network. These helpers turn one
 * into typed values or throw `RequestValidationError` naming the offending
 * path. Unknown keys are rejected rather than ignored: a client sending an
 * unexpected field is either out of date or misbehaving, and dropping the
 * field silently would hide that. The helpers stay deliberately small so the
 * service needs no schema dependency.
 */
import { RequestValidationError } from "./errors.js";

export function asRecord(value: unknown, path = ""): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestValidationError(path, "expected an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function rejectUnknownKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[], path = ""): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new RequestValidationError(path === "" ? key : `${path}.${key}`, "unknown field");
  }
}

export function requiredText(record: Readonly<Record<string, unknown>>, key: string, maxLength = 256): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") throw new RequestValidationError(key, "expected a non-empty string");
  if (value.length > maxLength) throw new RequestValidationError(key, `must be at most ${maxLength} characters`);
  return value;
}

export function optionalText(record: Readonly<Record<string, unknown>>, key: string, maxLength = 256): string | undefined {
  return record[key] === undefined ? undefined : requiredText(record, key, maxLength);
}

export function requiredInteger(record: Readonly<Record<string, unknown>>, key: string, min: number, max: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RequestValidationError(key, `expected an integer between ${min} and ${max}`);
  }
  return value;
}

export function optionalInteger(record: Readonly<Record<string, unknown>>, key: string, min: number, max: number, fallback: number): number {
  return record[key] === undefined ? fallback : requiredInteger(record, key, min, max);
}

/**
 * String-to-string metadata. Values are bounded because labels are stored and
 * echoed back to every client that can read the machine.
 */
export function optionalLabels(record: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, string>> {
  const value = record[key];
  if (value === undefined) return {};
  const labels = asRecord(value, key);
  const entries = Object.entries(labels);
  if (entries.length > 32) throw new RequestValidationError(key, "expected at most 32 labels");
  const result: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (typeof entry !== "string" || entry.length > 256) throw new RequestValidationError(`${key}.${name}`, "expected a string of at most 256 characters");
    result[name] = entry;
  }
  return result;
}
