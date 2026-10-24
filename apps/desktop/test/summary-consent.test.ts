import { test } from "node:test";
import assert from "node:assert/strict";
import { grantSummaryConsent } from "../src/main/transforms/consent.ts";

test("summary consent: granted to the service the page showed", () => {
  assert.deepEqual(
    grantSummaryConsent("groq", { provider: "groq", consent: ["gemini"] }),
    ["gemini", "groq"],
  );
  assert.deepEqual(
    grantSummaryConsent("groq", { provider: "groq", consent: ["groq"] }),
    ["groq"],
  );
});

test("summary consent: refused when the AI service changed after the page loaded", () => {
  assert.throws(
    () => grantSummaryConsent("groq", { provider: "gemini", consent: [] }),
    /service changed/,
  );
});
