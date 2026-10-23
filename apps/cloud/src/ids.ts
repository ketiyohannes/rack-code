/**
 * Identifiers and bearer secrets.
 *
 * Identifiers carry a type prefix (`acc_`, `sub_`, `mch_`) so a value pasted
 * into a log or a support ticket says what it refers to. Secrets are 32 random
 * bytes and are stored only as a SHA-256 digest: a fast hash is the right
 * choice here, unlike for passwords, because the input already has 256 bits of
 * entropy and a dictionary attack on it is not a thing that exists.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export interface GeneratedSecret {
  /** Returned to the caller once; the control plane cannot show it again. */
  readonly secret: string;
  readonly hash: string;
}

export function newSecret(prefix: string): GeneratedSecret {
  const secret = `${prefix}_${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashSecret(secret) };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Compares two hex digests without leaking their contents through timing. */
export function secretMatches(secret: string, hash: string): boolean {
  const presented = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(hash, "hex");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
