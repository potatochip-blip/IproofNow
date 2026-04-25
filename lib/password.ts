import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters for interactive logins.
// memoryCost is in KiB. 19 MiB / 2 iterations / 1-thread is the modern baseline.
// algorithm: 2 = Algorithm.Argon2id. Hard-coded because @node-rs/argon2 ships
// it as a const enum, and isolatedModules forbids accessing const enums.
const ARGON_OPTS = {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON_OPTS);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return argonVerify(hash, plaintext);
}
