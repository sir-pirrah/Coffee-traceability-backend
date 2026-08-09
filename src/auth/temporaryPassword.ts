import crypto from "node:crypto";

/**
 * Temporary passwords for accounts an administrator issues on someone else's
 * behalf.
 *
 * There is no email or SMS provider in this system, so the credential is handed
 * over on paper — read off a screen, written down, typed back in on a phone.
 * That constraint drives both choices below.
 */

// No 0/O/o, 1/l/I, or 5/S: the glyphs people transcribe wrongly. Dropping them
// costs about four bits, which the length below more than covers.
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZabcdefghijkmnpqrtuvwxyz23456789";

const GROUPS = 3;
const GROUP_SIZE = 4;

/** Days a temporary password stays valid before it has to be reissued. */
export const TEMPORARY_PASSWORD_TTL_DAYS = 7;

/**
 * A 12-character password in three hyphenated groups (`Kqf7-Rm4t-Wz9p`).
 *
 * `crypto.randomInt` rather than `Math.random()`: this value is the only thing
 * standing between a stranger and a farmer's delivery records until they change
 * it, so it has to come from a CSPRNG. Twelve characters of a 53-symbol alphabet
 * is roughly 68 bits — far beyond what the login rate limiter and lockout would
 * let anyone work through.
 *
 * The grouping is purely for transcription: it survives being read aloud and
 * copied by hand, which an unbroken string of twelve does not.
 */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < GROUP_SIZE; i += 1) {
      group += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

export function temporaryPasswordExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + TEMPORARY_PASSWORD_TTL_DAYS * 24 * 60 * 60 * 1000);
}
