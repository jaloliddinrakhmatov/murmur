// Stage B: the account screens' logic (names, email lists, codes, referral progress, plan
// display and team permissions).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canInvite,
  canLeave,
  canRename,
  creditText,
  displayName,
  emailsFromRows,
  initials,
  localDataSummary,
  inviteTokenFrom,
  isCompleteCode,
  isEmail,
  isReferralCode,
  maskEmail,
  memberActions,
  normalizeCode,
  normalizeReferralCode,
  parseEmails,
  planButton,
  planSummary,
  priceText,
  referralProgress,
  referralProgressText,
  referralShareText,
  referralStatus,
  resendWait,
  safeReferralLabel,
  sortMembers,
  subscriptionText,
  trialDaysLeft,
} from "../src/renderer/hub/model/account.ts";

const me = (
  firstName: string,
  lastName: string,
  email = "sam@example.com",
) => ({
  firstName,
  lastName,
  email,
});

test("names and initials", () => {
  assert.equal(displayName(me("Sam", "Rivera")), "Sam Rivera");
  assert.equal(displayName(me("Sam", "")), "Sam");
  assert.equal(displayName(me("", "", "sam.r@example.com")), "sam.r");
  assert.equal(initials(me("sam", "rivera")), "SR");
  assert.equal(initials(me("sam", "")), "S");
  assert.equal(initials(me("", "", "zed@example.com")), "Z");
});

test("masking keeps one letter and the domain", () => {
  assert.equal(maskEmail("jane@gmail.com"), "j***@gmail.com");
  assert.equal(maskEmail("no-at-sign"), "no-at-sign");
  assert.equal(safeReferralLabel("Jane"), "Jane");
  assert.equal(safeReferralLabel("j***@gmail.com"), "j***@gmail.com");
  assert.equal(
    safeReferralLabel("jane@gmail.com"),
    "j***@gmail.com",
    "a full address is never shown",
  );
});

test("email validation and pasted lists", () => {
  assert.ok(isEmail(" a@b.co "));
  assert.ok(!isEmail("a@b"));
  assert.ok(!isEmail("a b@c.com"));
  assert.ok(!isEmail(`${"x".repeat(250)}@b.com`));
  const l = parseEmails("A@x.com, b@x.com; bad\nB@X.com   c@x.com");
  assert.deepEqual(l.valid, ["a@x.com", "b@x.com", "c@x.com"]);
  assert.deepEqual(l.invalid, ["bad"]);
  assert.equal(l.tooMany, false);
  const many = parseEmails(
    Array.from({ length: 21 }, (_, i) => `p${i}@x.com`).join(" "),
  );
  assert.equal(many.tooMany, true);
  assert.deepEqual(emailsFromRows(["a@x.com", "", "  ", "oops"]).invalid, [
    "oops",
  ]);
});

test("sign-in codes: paste-friendly, six digits, resend after 30 seconds", () => {
  assert.equal(normalizeCode("123 456"), "123456");
  assert.equal(normalizeCode("12-34-56-78"), "123456");
  assert.equal(normalizeCode("abc12"), "12");
  assert.ok(isCompleteCode("123456"));
  assert.ok(!isCompleteCode("12345"));
  assert.equal(resendWait(1_000, 1_000), 30);
  assert.equal(resendWait(1_000, 11_500), 20);
  assert.equal(resendWait(1_000, 31_000), 0);
  assert.equal(resendWait(1_000, 99_000), 0);
});

test("referral and invite codes", () => {
  assert.equal(normalizeReferralCode("  sam-antha9 "), "SAMANTHA9");
  assert.ok(isReferralCode("ABCD"));
  assert.ok(!isReferralCode("ABC"));
  assert.ok(!isReferralCode("A".repeat(21)));
  assert.equal(inviteTokenFrom(" JOIN-1-CODE "), "JOIN-1-CODE");
  assert.equal(
    inviteTokenFrom("https://murmur.example/join/ABCD1234"),
    "ABCD1234",
  );
  assert.equal(
    inviteTokenFrom("https://murmur.example/join?token=XYZ98765"),
    "XYZ98765",
  );
});

test("the referral share text leads with the code and never a link", () => {
  const text = referralShareText("SAMANTHA9");
  assert.ok(text.includes("SAMANTHA9"));
  assert.match(text, /Apply referral/);
  assert.ok(!/https?:|\/r\//.test(text));
});

test("referral progress toward 2,000 words", () => {
  assert.deepEqual(referralProgress(0), {
    words: 0,
    goal: 2000,
    percent: 0,
    remaining: 2000,
    done: false,
  });
  assert.equal(referralProgress(1999).percent, 99, "never 100 before the goal");
  assert.equal(referralProgress(1999).done, false);
  const done = referralProgress(5000);
  assert.equal(done.percent, 100);
  assert.equal(done.words, 2000);
  assert.equal(done.done, true);
  assert.equal(referralProgress(-5).words, 0);
  assert.equal(
    referralProgressText({ words: 1234, status: "signed-up" }),
    "1,234 of 2,000 words",
  );
  assert.equal(
    referralProgressText({ words: 2100, status: "qualified" }),
    "2,000 words reached",
  );
  assert.equal(
    referralProgressText({ words: 2100, status: "rewarded" }),
    "Reward given",
  );
  assert.equal(referralStatus("rewarded").tone, "success");
  assert.equal(referralStatus("signed-up").label, "Signed up");
  assert.equal(creditText(1), "1 month of Pro");
  assert.equal(creditText(3), "3 months of Pro");
});

const plan = (
  id: "free" | "pro" | "enterprise",
  priceCents: number | null,
  priceIsFrom = false,
) => ({
  id,
  name: id,
  audience: "",
  priceCents,
  priceIsFrom,
  discountPct: 0,
  features: [],
});

test("plan prices and buttons", () => {
  assert.deepEqual(priceText(plan("free", 0), "usd"), {
    amount: "Free",
    unit: "",
  });
  assert.deepEqual(priceText(plan("pro", 1500), "usd"), {
    amount: "$15",
    unit: "per user / month",
  });
  assert.equal(priceText(plan("pro", 1250), "usd").amount, "$12.50");
  assert.equal(
    priceText(plan("enterprise", 3000, true), "usd").amount,
    "From $30",
  );
  assert.deepEqual(priceText(plan("enterprise", null), "usd"), {
    amount: "Contact us",
    unit: "",
  });
  assert.deepEqual(planButton(plan("pro", 1500), "pro"), {
    kind: "current",
    label: "Current plan",
  });
  assert.equal(planButton(plan("pro", 1500), "free").kind, "select");
  assert.equal(
    planButton(plan("pro", 1500), "enterprise").label,
    "Switch to Pro",
  );
  assert.equal(planButton(plan("free", 0), "pro").kind, "none");
  assert.equal(planButton(plan("enterprise", null), "pro").kind, "contact");
});

test("plan and subscription wording", () => {
  assert.equal(
    planSummary({ tier: "free", source: "none", until: null }),
    "Free plan",
  );
  assert.match(
    planSummary({
      tier: "pro",
      source: "trial",
      until: "2026-11-03T00:00:00.000Z",
    }),
    /^Pro, team trial until /,
  );
  assert.match(
    planSummary({
      tier: "pro",
      source: "referral",
      until: "2026-11-03T00:00:00.000Z",
    }),
    /referral credit until /,
  );
  assert.match(
    planSummary({
      tier: "pro",
      source: "subscription",
      until: "2026-11-03T00:00:00.000Z",
    }),
    /^Pro, renews /,
  );
  const sub = {
    plan: "pro" as const,
    interval: "annual" as const,
    seats: 3,
    status: "active" as const,
    currentPeriodEnd: "2026-11-03T12:00:00.000Z",
    cancelAtPeriodEnd: false,
  };
  assert.match(subscriptionText(sub), /^Renews .* · 3 seats, billed yearly$/);
  assert.match(
    subscriptionText({ ...sub, cancelAtPeriodEnd: true }),
    /^Ends .* · 3 seats$/,
  );
  assert.match(
    subscriptionText({ ...sub, status: "past_due", seats: 1 }),
    /overdue · 1 seat,/,
  );
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(trialDaysLeft("2026-11-03T12:00:00Z", now), 14);
  assert.equal(trialDaysLeft("2026-10-20T13:00:00Z", now), 1);
  assert.equal(trialDaysLeft("2026-10-19T00:00:00Z", now), 0);
  assert.equal(trialDaysLeft(null, now), null);
});

test("team permissions", () => {
  assert.ok(canInvite("owner") && canInvite("admin") && !canInvite("member"));
  assert.ok(canRename("owner") && !canRename("admin"));
  assert.ok(!canLeave("owner") && canLeave("admin") && canLeave("member"));
  const t = (role: "owner" | "admin" | "member", isSelf = false) => ({
    role,
    isSelf,
  });
  assert.deepEqual(memberActions("owner", t("member")), {
    setRole: "admin",
    remove: true,
  });
  assert.deepEqual(memberActions("owner", t("admin")), {
    setRole: "member",
    remove: true,
  });
  assert.deepEqual(memberActions("owner", t("owner", true)), {
    setRole: null,
    remove: false,
  });
  assert.deepEqual(memberActions("admin", t("member")), {
    setRole: null,
    remove: true,
  });
  assert.deepEqual(memberActions("admin", t("admin")), {
    setRole: null,
    remove: false,
  });
  assert.deepEqual(memberActions("admin", t("owner")), {
    setRole: null,
    remove: false,
  });
  assert.deepEqual(memberActions("member", t("member")), {
    setRole: null,
    remove: false,
  });
  const m = (
    userId: string,
    name: string,
    role: "owner" | "admin" | "member",
  ) => ({
    userId,
    email: `${userId}@x.com`,
    name,
    role,
    joinedAt: "2026-10-01T00:00:00.000Z",
  });
  assert.deepEqual(
    sortMembers([
      m("c", "Cy", "member"),
      m("a", "Al", "member"),
      m("o", "Zed", "owner"),
      m("d", "Di", "admin"),
    ]).map((x) => x.userId),
    ["o", "d", "a", "c"],
  );
});

test("codeSentCopy says 'emailed' only when an email was sent", async () => {
  const { codeSentCopy, NEWEST_CODE_NOTE } =
    await import("../src/renderer/hub/model/account.ts");
  const sent = codeSentCopy("email", "a@b.co");
  assert.match(sent.before, /^We emailed a 6-digit code to/);
  assert.equal(sent.email, "a@b.co");
  const outbox = codeSentCopy("outbox", "a@b.co");
  assert.equal(
    outbox.before,
    "Email isn't set up on this server yet. Your code is in the test outbox.",
  );
  assert.equal(outbox.email, null);
  assert.match(NEWEST_CODE_NOTE, /Only the newest code works/);
});

test("another account: this Mac's data in words, zeros left out", () => {
  const none = {
    dictations: 0,
    notes: 0,
    meetings: 0,
    dictionary: 0,
    snippets: 0,
  };
  assert.equal(localDataSummary(none), "no data");
  assert.equal(localDataSummary({ ...none, notes: 1 }), "1 note");
  assert.equal(
    localDataSummary({ ...none, dictations: 1312, dictionary: 1 }),
    "1,312 dictations and 1 dictionary word",
  );
  assert.equal(
    localDataSummary({
      dictations: 2,
      notes: 3,
      meetings: 1,
      dictionary: 4,
      snippets: 5,
    }),
    "2 dictations, 3 notes, 1 meeting, 4 dictionary words and 5 snippets",
  );
});
