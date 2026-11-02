// Masking for anything printed or logged (CLAUDE.md rule 4). Raw values stay in the database only.

/** "anna.virtanen@example.com" → "a***@example.com". Without an @, only the first character is kept. */
export function maskEmail(email: string | null): string {
  if (email === null) return "(missing)";
  if (email.trim() === "") return "(empty)";
  const at = email.indexOf("@");
  if (at <= 0) return `${email[0]}***`;
  return `${email[0]}***${email.slice(at)}`;
}

/** "+358 40 123 4512" → "+358 *** ** 12". Only the country code and the last two characters are kept. */
export function maskPhone(phone: string | null): string {
  if (phone === null) return "(missing)";
  const compact = phone.replace(/ /g, "");
  if (compact === "") return "(empty)";
  if (compact.length <= 4) return "***";
  const prefix = compact.startsWith("+358") ? "+358 " : "";
  return `${prefix}*** ** ${compact.slice(-2)}`;
}
