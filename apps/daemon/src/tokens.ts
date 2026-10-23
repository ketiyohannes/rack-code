/**
 * Pairing tokens: the daemon's only authentication.
 *
 * A token is a 256-bit random value generated on first start and shown to
 * the user once, so a controller can be paired by copying it (or scanning it
 * as a QR code on mobile). There is no account system here on purpose — the
 * daemon authenticates devices, and `apps/cloud` is what authenticates
 * people.
 *
 * Three details matter and are easy to get wrong:
 *
 * - **Comparison is constant-time.** A `===` on the token leaks its prefix
 *   through timing to anyone who can connect, which on a tailnet or a relay
 *   is a realistic position to be in.
 * - **The file is created with mode 0600 and never widened.** A token
 *   readable by other local accounts is equivalent to handing them a shell.
 * - **An environment-supplied token is never written to disk.** In a VM or
 *   container the secret is injected per boot, and persisting it would
 *   outlive the machine it was issued for.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Bytes of entropy per token. 32 bytes is 43 base64url characters. */
const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Reads the token at `path`, creating one if the file does not exist. The
 * returned `created` flag lets the caller print a first-run pairing notice
 * exactly once rather than on every start.
 */
export async function loadOrCreateToken(path: string): Promise<{ token: string; created: boolean }> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing !== "") return { token: existing, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = generateToken();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // `mode` on writeFile only applies when the file is created, so an
  // existing file with loose permissions is tightened explicitly below.
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return { token, created: true };
}

/**
 * Constant-time token check. Length is compared first because
 * `timingSafeEqual` throws on a length mismatch; the length of a token is
 * not a secret, since it is fixed by `generateToken`.
 */
export function createTokenVerifier(expected: string): (candidate: string) => boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  return (candidate: string): boolean => {
    if (typeof candidate !== "string") return false;
    const candidateBytes = Buffer.from(candidate, "utf8");
    if (candidateBytes.length !== expectedBytes.length) return false;
    return timingSafeEqual(candidateBytes, expectedBytes);
  };
}
