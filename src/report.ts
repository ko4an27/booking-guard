import type { CheckResults, Issue } from "./checks.ts";
import { maskEmail, maskPhone } from "./mask.ts";

export const CHECK_TITLES: Record<keyof CheckResults, string> = {
  duplicateBookings: "Duplicate bookings",
  doubleBookedSlots: "Double-booked slots",
  pastOrCancelledEvents: "Bookings for past or cancelled events",
  badContacts: "Empty or malformed contact data",
  overbookedEvents: "Overbooked events",
};

/** One line per issue. Emails and phones are always masked. */
export function describeIssue(issue: Issue): string {
  switch (issue.type) {
    case "duplicate_booking":
      return `event ${issue.eventId} (${issue.city} ${issue.date}): customer ${issue.customerId} ${maskEmail(issue.email)} booked ${issue.bookingIds.length}× — bookings ${issue.bookingIds.join(", ")}`;
    case "double_booked_slot":
      return `event ${issue.eventId} (${issue.city} ${issue.date}) slot ${issue.slot}: customers ${issue.customerIds.join(", ")} — bookings ${issue.bookingIds.join(", ")}`;
    case "past_or_cancelled_event":
      return `booking ${issue.bookingId}: customer ${issue.customerId}, event ${issue.eventId} (${issue.city} ${issue.date}) is ${issue.reasons.join(" and ")}`;
    case "bad_contact":
      return `customer ${issue.customerId}: email ${maskEmail(issue.email)}, phone ${maskPhone(issue.phone)} — ${issue.problems.join(", ")} (${issue.bookingCount} booking${issue.bookingCount === 1 ? "" : "s"})`;
    case "overbooked_event":
      return `event ${issue.eventId} (${issue.city} ${issue.date}): ${issue.booked} bookings for capacity ${issue.capacity} (+${issue.booked - issue.capacity})`;
  }
}

/** The text `npm run check` prints. `examples` = how many issues to list per check (Infinity = all). */
export function formatSummary(results: CheckResults, options: { today: string; examples?: number }): string {
  const limit = options.examples ?? 3;
  const lines = [`Booking Guard — data check (today = ${options.today})`, ""];
  let total = 0;
  for (const key of Object.keys(CHECK_TITLES) as Array<keyof CheckResults>) {
    const issues: Issue[] = results[key];
    total += issues.length;
    lines.push(`${CHECK_TITLES[key]}: ${issues.length}`);
    for (const issue of issues.slice(0, limit)) lines.push(`  - ${describeIssue(issue)}`);
    if (issues.length > limit) lines.push(`  … and ${issues.length - limit} more`);
  }
  lines.push("", total === 0 ? "No issues found." : `Total: ${total} issues. Nothing was changed.`);
  return lines.join("\n");
}
