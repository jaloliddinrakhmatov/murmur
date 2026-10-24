import { RULES } from "@murmur/account-api";

export const PRICING_FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need to pay to use Murmur?",
    a: "No. The Free plan covers dictating in any app, the dictionary, snippets and a local history. You can use Murmur without an account.",
  },
  {
    q: "Are these prices final?",
    a: "No. The prices on this page are placeholders while the plans are being decided, and paid plans can't be bought yet. We'll update this page before anything goes on sale.",
  },
  {
    q: "How does annual billing work?",
    a: "Annual billing charges for twelve months at once at a lower monthly-equivalent price. Toggle Annual above to see the discount on each plan.",
  },
  {
    q: "Is there a trial for teams?",
    a: `Creating a team starts a ${RULES.teamTrialDays}-day Pro trial for everyone in it. Invites are valid for ${RULES.teamInviteDays} days.`,
  },
  {
    q: "Can I get Pro for free?",
    a: `Yes, a month at a time. A friend who applies your referral code gets ${RULES.referralRewardMonths} month of Pro, and you get one too once they have dictated ${RULES.referralRewardWords.toLocaleString("en-US")} words.`,
  },
  {
    q: "What about Enterprise?",
    a: "Enterprise is priced by conversation. Use Contact us on the plan and tell us about your team.",
  },
];
