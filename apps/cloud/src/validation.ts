/**
 * Request validation primitives.
 *
 * Request bodies arrive as `unknown` from the public internet, so every field
 * the control plane reads passes through one of these. Unknown keys are
 * rejected rather than ignored: a client sending an unexpected field is
 * either out of date or probing, and dropping it silently hides both.
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

export function optionalInteger(record: Readonly<Record<string, unknown>>, key: string, min: number, max: number): number | undefined {
  return record[key] === undefined ? undefined : requiredInteger(record, key, min, max);
}

export function optionalBoolean(record: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new RequestValidationError(key, "expected a boolean");
  return value;
}

export function requiredStringArray(record: Readonly<Record<string, unknown>>, key: string, maxItems: number, maxLength = 256): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new RequestValidationError(key, `expected between 1 and ${maxItems} strings`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "" || entry.length > maxLength) {
      throw new RequestValidationError(`${key}[${index}]`, `expected a non-empty string of at most ${maxLength} characters`);
    }
    return entry;
  });
}

/**
 * Addresses are normalized (trimmed, lower-cased) before storage so that one
 * person cannot hold two accounts that differ only in case. The shape check is
 * deliberately loose — one `@`, no spaces, a dot in the domain — because
 * stricter patterns reject valid addresses, and deliverability is established
 * by sending mail, not by a regular expression.
 */
export function requiredEmail(record: Readonly<Record<string, unknown>>, key: string): string {
  const raw = requiredText(record, key, 254).trim().toLowerCase();
  const at = raw.indexOf("@");
  if (at <= 0 || at !== raw.lastIndexOf("@") || /\s/.test(raw) || !raw.slice(at + 1).includes(".") || raw.endsWith(".")) {
    throw new RequestValidationError(key, "expected an email address");
  }
  return raw;
}

/**
 * Length is the only password rule enforced. Composition rules push people
 * towards predictable substitutions without adding entropy; a 12-character
 * minimum with a stored scrypt hash is the useful part.
 */
export function requiredPassword(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new RequestValidationError(key, "expected a string");
  if (value.length < 12) throw new RequestValidationError(key, "must be at least 12 characters");
  if (value.length > 256) throw new RequestValidationError(key, "must be at most 256 characters");
  return value;
}
