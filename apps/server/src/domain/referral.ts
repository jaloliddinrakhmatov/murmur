import { RULES } from "@murmur/account-api";
import { maskEmail } from "../common/mask.ts";

export interface RewardInput {
  status: string;
  totalWords: number;
  /** Distinct days with words reported. */
  activeDays: number;
  accountAgeMs: number;
  /** Months this referrer was already paid in the last 365 days. */
  referrerRewardsThisYear: number;
  /** The friend's address was already paid for once (survives account deletion). */
  alreadyPaidForAddress: boolean;
}

export interface RewardRules {
  minActiveDays: number;
  minAccountAgeDays: number;
  maxRewardsPerYear: number;
}

/**
 * A referral pays out once, when the friend has dictated enough words (reported on several
 * different days, so one self-reported number isn't enough), the friend's account is a few days
 * old, the address was never paid for before, and the referrer is under the yearly cap.
 */
export function shouldReward(input: RewardInput, rules: RewardRules): boolean {
  return (
    input.status !== "rewarded" &&
    input.totalWords >= RULES.referralRewardWords &&
    input.activeDays >= rules.minActiveDays &&
    input.accountAgeMs >= rules.minAccountAgeDays * 86_400_000 &&
    input.referrerRewardsThisYear < rules.maxRewardsPerYear &&
    !input.alreadyPaidForAddress
  );
}

/** Progress shown to the referrer is capped so a friend's exact usage is never revealed. */
export function visibleWords(totalWords: number): number {
  return Math.min(
    Math.max(0, Math.trunc(totalWords)),
    RULES.referralRewardWords,
  );
}

/** The local part of the address as A–Z0–9, at most 12 characters, at least 3. */
export function referralBase(
  email: string,
  random: () => number = Math.random,
): string {
  const local = email.split("@")[0] ?? "";
  let base = local
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  while (base.length < 3) {
    base += String.fromCharCode(65 + Math.floor(random() * 26));
  }
  return base;
}

/** Candidate codes: the base plus one digit, then more digits after repeated collisions. */
export function referralCodeCandidate(
  email: string,
  attempt: number,
  random: () => number = Math.random,
): string {
  const digits = 1 + Math.floor(attempt / 5);
  let suffix = "";
  for (let i = 0; i < digits; i++) suffix += Math.floor(random() * 10);
  return referralBase(email, random) + suffix;
}

/** The friend's first name, or a masked email, never the full address. */
export function referralLabel(firstName: string, email: string): string {
  const name = firstName.trim();
  if (name) return name;
  return maskEmail(email);
}
