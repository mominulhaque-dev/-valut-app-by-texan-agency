import { randomInt } from "node:crypto";

/**
 * Crockford base32 with 0 and 1 also removed: no 0/O, no 1/I/L, no U.
 * 30 symbols, 12 characters, about 59 bits of entropy.
 *
 * Ring IDs are engraved on metal. Changing this alphabet or length after the
 * first production ring exists is not possible.
 */
export const RING_ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RING_ID_LENGTH = 12;
export const RING_ID_PATTERN = /^[2-9A-HJKMNP-TV-Z]{12}$/;

export function isRingId(value: unknown): value is string {
  return typeof value === "string" && RING_ID_PATTERN.test(value);
}

/**
 * Cryptographically random and never derived from order data: a guessable ID
 * would let a stranger claim someone else's vault. `randomInt` is unbiased
 * (rejection sampling), which matters because 30 is not a power of two.
 */
export function generateRingId(): string {
  let id = "";
  for (let i = 0; i < RING_ID_LENGTH; i++) {
    id += RING_ID_ALPHABET[randomInt(RING_ID_ALPHABET.length)];
  }
  return id;
}
