import { hash as argonHash, verify as argonVerify, Algorithm } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters for interactive logins.
// memoryCost is in KiB. 19 MiB / 2 iterations / 1-thread is the modern baseline.
const ARGON_OPTS = {
  algorithm: Algorithm.Argon2id,
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
