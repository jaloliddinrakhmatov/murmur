// Interactive: asks which AI service answers the website's help chat, its API key (hidden) and an
// optional model, and writes only the MURMUR_HELP_* lines of apps/server/.env (mode 0600).
// Never prints the key.
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HELP_ENDPOINTS } from "../src/help/model.ts";
import { updateEnvFile } from "../src/mail/write-env.ts";
import { askHidden } from "./ask-hidden.ts";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

if (!process.stdin.isTTY) {
  console.error(
    "Run this in a terminal: it asks for the API key with hidden input.",
  );
  process.exit(1);
}

try {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const names = Object.keys(HELP_ENDPOINTS);
  const provider =
    (await rl.question(`AI service (${names.join(", ")}) [groq]: `))
      .trim()
      .toLowerCase() || "groq";
  if (!(provider in HELP_ENDPOINTS)) {
    throw new Error(`Choose one of: ${names.join(", ")}. Nothing was saved.`);
  }
  const fallback =
    HELP_ENDPOINTS[provider as keyof typeof HELP_ENDPOINTS].model;
  const model = (await rl.question(`Model (empty = ${fallback}): `)).trim();
  const contact = (
    await rl.question("Contact email shown to visitors (optional): ")
  ).trim();
  rl.close();
  const key = (await askHidden(`${provider} API key (hidden): `)).trim();
  if (key.length < 16 || /\s/.test(key)) {
    throw new Error("That doesn't look like an API key. Nothing was saved.");
  }
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(model)) {
    throw new Error("That isn't a valid model name. Nothing was saved.");
  }
  if (contact && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contact)) {
    throw new Error(
      "That doesn't look like an email address. Nothing was saved.",
    );
  }
  updateEnvFile(envPath, {
    MURMUR_HELP_PROVIDER: provider,
    MURMUR_HELP_API_KEY: key,
    MURMUR_HELP_MODEL: model,
    ...(contact ? { MURMUR_HELP_CONTACT: contact } : {}),
  });
  console.log(
    "Saved the help chat settings to apps/server/.env (owner-only, mode 0600).",
  );
  console.log("Next: npm run help:test -w apps/server (spends a tiny amount)");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Setup failed.");
  process.exit(1);
}
