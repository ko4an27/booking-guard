// Rules for "valid" contact data. They match the rules documented in tests/expected.json.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+358\d{7,10}$/;

export type ContactProblem = "email_missing" | "email_malformed" | "phone_missing" | "phone_malformed";

/** Something, then exactly one @, then a domain with a dot. No spaces anywhere. */
export function isValidEmail(email: string | null): boolean {
  return email !== null && EMAIL_RE.test(email);
}

/** A Finnish number in international format: +358 and 7–10 digits. Spaces are allowed and ignored. */
export function isValidPhone(phone: string | null): boolean {
  return phone !== null && PHONE_RE.test(phone.replace(/ /g, ""));
}

/** Lists what is wrong with a customer's contact data; an empty list means it is fine. */
export function contactProblems(c: { email: string | null; phone: string | null }): ContactProblem[] {
  const problems: ContactProblem[] = [];
  if (c.email === null || c.email.trim() === "") problems.push("email_missing");
  else if (!isValidEmail(c.email)) problems.push("email_malformed");
  if (c.phone === null || c.phone.trim() === "") problems.push("phone_missing");
  else if (!isValidPhone(c.phone)) problems.push("phone_malformed");
  return problems;
}
