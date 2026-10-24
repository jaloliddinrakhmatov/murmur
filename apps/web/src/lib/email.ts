/** Light checks for the waitlist form. The server has the final say (it uses the shared contract). */

export const EMAIL_MAX = 254;

export type EmailCheck =
  | { ok: true; email: string }
  | { ok: false; reason: "empty" | "invalid" | "too-long" };

export function checkEmail(input: string): EmailCheck {
  const email = input.trim().toLowerCase();
  if (!email) return { ok: false, reason: "empty" };
  if (email.length > EMAIL_MAX) return { ok: false, reason: "too-long" };
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[^\s@.]{2,}$/.test(email)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, email };
}

export function emailProblem(
  reason: Exclude<EmailCheck, { ok: true }>["reason"],
): string {
  switch (reason) {
    case "empty":
      return "Enter your email address.";
    case "too-long":
      return "That address is too long.";
    case "invalid":
      return "That doesn't look like an email address. Check it and try again.";
  }
}
