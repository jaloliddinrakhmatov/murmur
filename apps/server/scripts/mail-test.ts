// Sends one test email through the configured SMTP. Usage: npm run mail:test -w apps/server -- --to you@example.com
import { maskEmail } from "../src/common/mask.ts";
import { parseSmtpConfig } from "../src/mail/smtp.config.ts";
import { SmtpMailer } from "../src/mail/smtp.mailer.ts";

const i = process.argv.indexOf("--to");
const to = i >= 0 ? process.argv[i + 1]?.trim() : undefined;
if (!to || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(to)) {
  console.error(
    "Usage: npm run mail:test -w apps/server -- --to someone@example.com",
  );
  process.exit(2);
}

let config;
try {
  config = parseSmtpConfig(process.env);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid SMTP settings.",
  );
  process.exit(1);
}
if (!config) {
  console.error("SMTP isn't set up. Run: npm run mail:setup -w apps/server");
  process.exit(1);
}

try {
  await new SmtpMailer(config).send({
    to,
    // No code and its own kind: a test must never look like a sign-in email (someone typed the
    // sample code from it into the sign-in dialog).
    kind: "test",
    subject: "Murmur: email sending works",
    text: "This is a test from your Murmur server. It is not a sign-in email and has no code.\n\nIf you can read this, Murmur can send email from this address.",
  });
  console.log(`Sent a test email to ${maskEmail(to)}.`);
} catch {
  console.error(
    `Couldn't send to ${maskEmail(to)}. Check the Gmail address and app password (npm run mail:setup -w apps/server) and that 2-Step Verification is on.`,
  );
  process.exit(1);
}
