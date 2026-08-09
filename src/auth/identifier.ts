import { UserRole } from "@prisma/client";

/**
 * Login identifiers.
 *
 * The sign-in form takes one field rather than three, because the person typing
 * into it does not think of themselves as choosing an identifier type — a farmer
 * has the code printed on their slip, staff have an email. Classifying the input
 * here keeps that decision out of the UI and off the user.
 */
export type IdentifierKind = "email" | "phone" | "farmerCode";

const FARMER_CODE = /^FARM-\d{4}-\d+$/i;

/**
 * Canonicalises a Kenyan mobile number to `+2547XXXXXXXX`.
 *
 * The same phone is written `0712345678`, `+254712345678`, `254712345678`, or
 * bare `712345678` depending on who filled in the form, and any of those may be
 * what someone types at login. Since the number is a *unique lookup key* here,
 * storing and comparing one canonical form is what makes the lookup work at all —
 * otherwise the same person is two different rows.
 *
 * Returns null when the input isn't a recognisable Kenyan mobile, so callers can
 * reject it rather than store something that will never match.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, "").replace(/^\+/, "");
  if (!/^\d+$/.test(digits)) return null;

  let local: string;
  if (digits.startsWith("254")) local = digits.slice(3);
  else if (digits.startsWith("0")) local = digits.slice(1);
  else local = digits;

  // Kenyan mobiles are nine digits after the country code, starting 1 or 7.
  if (!/^[17]\d{8}$/.test(local)) return null;
  return `+254${local}`;
}

export function classifyIdentifier(raw: string): IdentifierKind {
  const value = raw.trim();
  if (value.includes("@")) return "email";
  if (FARMER_CODE.test(value)) return "farmerCode";
  return "phone";
}

/**
 * The identifier to print on a farmer's credential slip: whichever one they can
 * actually be expected to have in hand. A farmer code always exists, so this
 * never comes back empty — which is what guarantees a provisioned account stays
 * reachable even with no email and no phone on file.
 */
export function preferredIdentifier(
  user: { email: string | null; phoneNumber: string | null; role: UserRole },
  farmerCode?: string
): string {
  if (user.role === "FARMER" && farmerCode) return farmerCode;
  return user.email ?? user.phoneNumber ?? farmerCode ?? "";
}
