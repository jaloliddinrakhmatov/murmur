import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES } from "@murmur/account-api";
import {
  referralBase,
  referralCodeCandidate,
  referralLabel,
  shouldReward,
  visibleWords,
} from "../../src/domain/referral.ts";
import { ReferralCodeSchema } from "@murmur/account-api";

const rules = { minActiveDays: 3, minAccountAgeDays: 3, maxRewardsPerYear: 12 };
const ok = {
  status: "signed-up",
  totalWords: RULES.referralRewardWords,
  activeDays: 3,
  accountAgeMs: 3 * 86_400_000,
  referrerRewardsThisYear: 0,
  alreadyPaidForAddress: false,
};

test("reward fires at the threshold and never twice", () => {
  const w = RULES.referralRewardWords;
  assert.equal(shouldReward({ ...ok, totalWords: w - 1 }, rules), false);
  assert.equal(shouldReward(ok, rules), true);
  assert.equal(shouldReward({ ...ok, status: "qualified" }, rules), true);
  assert.equal(
    shouldReward({ ...ok, status: "rewarded", totalWords: w * 10 }, rules),
    false,
  );
});

test("reward needs several active days, an aged account, a fresh address and a referrer under the cap", () => {
  assert.equal(shouldReward({ ...ok, activeDays: 2 }, rules), false);
  assert.equal(
    shouldReward({ ...ok, accountAgeMs: 3 * 86_400_000 - 1 }, rules),
    false,
  );
  assert.equal(
    shouldReward({ ...ok, alreadyPaidForAddress: true }, rules),
    false,
  );
  assert.equal(
    shouldReward({ ...ok, referrerRewardsThisYear: 11 }, rules),
    true,
  );
  assert.equal(
    shouldReward({ ...ok, referrerRewardsThisYear: 12 }, rules),
    false,
  );
});

test("progress shown to the referrer is capped and clean", () => {
  assert.equal(visibleWords(500), 500);
  assert.equal(visibleWords(99_999), RULES.referralRewardWords);
  assert.equal(visibleWords(-5), 0);
  assert.equal(visibleWords(12.9), 12);
});

test("referral codes come from the local part plus digits and satisfy the contract", () => {
  assert.equal(referralBase("samantha.riverside@example.com"), "SAMANTHARIVE");
  assert.equal(
    referralBase("a@x.com", () => 0),
    "AAA".slice(0, 3),
  );
  assert.equal(referralBase("---@x.com", () => 0).length, 3);
  const code = referralCodeCandidate("samantha@x.com", 0, () => 0.95);
  assert.equal(code, "SAMANTHA9");
  assert.equal(
    referralCodeCandidate("samantha@x.com", 5, () => 0.15).length,
    "SAMANTHA".length + 2,
  );
  for (let i = 0; i < 40; i++) {
    const c = referralCodeCandidate("some.person+tag@example.com", i);
    assert.equal(ReferralCodeSchema.safeParse(c).success, true, c);
  }
});

test("labels use the first name or a masked address, never the full email", () => {
  assert.equal(referralLabel("Ada", "ada@x.com"), "Ada");
  assert.equal(referralLabel("  ", "jane@gmail.com"), "j***@gmail.com");
  assert.equal(referralLabel("", "@bad"), "***");
});
