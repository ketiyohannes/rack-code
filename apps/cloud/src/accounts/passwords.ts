/**
 * Password hashing with scrypt from `node:crypto`.
 *
 * scrypt is memory-hard and ships with Node, which keeps the control plane
 * free of a native dependency. The cost parameters are stored with each hash
 * so they can be raised later without invalidating existing passwords: a
 * verification reads the parameters from the record, and a re-hash on next
 * sign-in can upgrade it.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { PasswordHash } from "./types.js";

/** 2^15 * 8 * 128 bytes = 32 MiB per hash. */
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;
/** scrypt refuses to allocate past `maxmem`, whose default is below the above. */
const MAX_MEMORY = 128 * COST * BLOCK_SIZE * 2;

function derive(password: string, salt: Buffer, parameters: Omit<PasswordHash, "salt" | "hash">): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      parameters.keyLength,
      { N: parameters.cost, r: parameters.blockSize, p: parameters.parallelization, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(16);
  const parameters = { algorithm: "scrypt", cost: COST, blockSize: BLOCK_SIZE, parallelization: PARALLELIZATION, keyLength: KEY_LENGTH } as const;
  const key = await derive(password, salt, parameters);
  return { ...parameters, salt: salt.toString("base64"), hash: key.toString("base64") };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, "base64");
  const key = await derive(password, Buffer.from(stored.salt, "base64"), stored);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
