// Interactive: asks for the Gmail address and the app password (hidden) and writes only the
// MURMUR_SMTP_* / MURMUR_MAIL_FROM lines of apps/server/.env (mode 0600). Never prints the password.
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { askHidden } from "./ask-hidden.ts";
import { updateEnvFile } from "../src/mail/write-env.ts";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (!process.stdin.isTTY) {
  console.error(
    "Run this in a terminal: it asks for the app password with hidden input.",
  );
  process.exit(1);
}

try {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const user = (await rl.question("Gmail address: ")).trim();
  rl.close();
  const pass = (
    await askHidden("App password (16 characters, hidden): ")
  ).replace(/\s+/g, "");
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(user)) {
    throw new Error("That doesn't look like an email address.");
  }
  if (pass.length !== 16) {
    throw new Error(
      `A Google app password has 16 characters; you entered ${pass.length}. Nothing was saved.`,
    );
  }
  updateEnvFile(envPath, {
    MURMUR_SMTP_HOST: "smtp.gmail.com",
    MURMUR_SMTP_PORT: "587",
    MURMUR_SMTP_USER: user,
    MURMUR_SMTP_PASS: pass,
    MURMUR_MAIL_FROM: `"Murmur" <${user}>`,
  });
  console.log(
    `Saved the email settings to apps/server/.env (owner-only, mode 0600).`,
  );
  console.log("Next: npm run mail:test -w apps/server -- --to you@example.com");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setup failed.");
  process.exit(1);
}
