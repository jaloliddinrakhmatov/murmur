import { RULES } from "@murmur/account-api";
import type { LegalDoc } from "./legal-types.ts";

export const TERMS_DOC: LegalDoc = {
  eyebrow: "Legal",
  title: "Terms of service",
  updated: "2026-10-21",
  sections: [
    {
      id: "agreement",
      title: "The agreement",
      blocks: [
        {
          p: "These terms are between you and [Company name], [Company address] (\u201cwe\u201d), and cover the Murmur app for Mac, this website and the optional Murmur account. By using them you agree to these terms and to the privacy policy. If you use Murmur for an organization, you confirm you may accept these terms for it.",
        },
      ],
    },
    {
      id: "using",
      title: "Using Murmur",
      blocks: [
        {
          p: "We give you a personal, non-exclusive, non-transferable licence to install and use the app on Macs you own or control. You agree not to:",
        },
        {
          ul: [
            "copy, resell or reverse engineer the app except where the law allows it;",
            "use it to break the law, or to record people without the consent the law requires;",
            "attack, overload or probe our servers, or work around limits such as referral or rate limits.",
          ],
        },
        {
          p: "You are responsible for who you record. Dictating in a meeting or call may need the consent of the other people. The Notetaker records only after you press Start and shows that it is recording.",
        },
      ],
    },
    {
      id: "services",
      title: "Third-party services and your keys",
      blocks: [
        {
          p: "Murmur transcribes and processes text using services you choose and pay for with your own API keys. Those services are governed by their own terms and fees, and we are not responsible for them. Keep your keys secret; you are responsible for use of them.",
        },
        {
          p: "Transcripts and AI output can be wrong. Check anything important before relying on it, including before it is sent.",
        },
      ],
    },
    {
      id: "account",
      title: "Accounts and teams",
      blocks: [
        {
          p: "An account is optional. Sign-in uses a code sent to your email, so keep that mailbox secure. You can delete your account at any time.",
        },
        {
          ul: [
            `Creating a team starts a ${RULES.teamTrialDays}-day Pro trial for the team. Team invitations expire after ${RULES.teamInviteDays} days and work only for the address they were sent to.`,
            "Team owners and admins manage members and invitations. Leaving or being removed ends your team plan.",
          ],
        },
      ],
    },
    {
      id: "referrals",
      title: "Referrals and free months",
      blocks: [
        {
          p: `A friend who applies your code within ${RULES.referralApplyWindowDays} days of creating an account gets ${RULES.referralRewardMonths} month of Pro. You get ${RULES.referralRewardMonths} month when they have dictated ${RULES.referralRewardWords.toLocaleString("en-US")} words, over at least three days, subject to checks that stop abuse. You cannot use your own code, and we may refuse or withdraw rewards we believe were farmed.`,
        },
      ],
    },
    {
      id: "plans",
      title: "Plans, prices and payment",
      blocks: [
        {
          p: "Free, Pro and Enterprise plans are described on the pricing page. Prices shown there are not final and paid plans are not yet on sale. When they are, this section will state prices, taxes, billing intervals, renewals, cancellation and refunds, and [Payment provider] will process payment.",
        },
      ],
    },
    {
      id: "content",
      title: "Your content",
      blocks: [
        {
          p: "What you dictate and write is yours. We do not receive it, except what you choose to send to a service you set up, and we claim no rights over it. You give us permission only to process the little data our server holds, as the privacy policy describes, in order to run your account.",
        },
      ],
    },
    {
      id: "availability",
      title: "Availability and changes",
      blocks: [
        {
          p: "Murmur is in development. Features may change or stop, and we may update these terms by posting the new version here. Continued use after a change means you accept it.",
        },
      ],
    },
    {
      id: "warranty",
      title: "No warranty and limits of liability",
      blocks: [
        {
          p: 'The app and website are provided "as is", without promises that they will be error free or always available. To the extent the law allows, we are not liable for indirect or consequential loss, or for loss of data or profit, and our total liability is limited to [liability cap]. Nothing here limits liability that cannot be limited by law.',
        },
      ],
    },
    {
      id: "ending",
      title: "Ending these terms",
      blocks: [
        {
          p: "You can stop using Murmur at any time. We may suspend or end an account that breaks these terms. Sections that by their nature should continue, such as liability limits, continue.",
        },
      ],
    },
    {
      id: "law",
      title: "Governing law and contact",
      blocks: [
        {
          p: "These terms are governed by the laws of [Governing law], and disputes go to the courts of [Jurisdiction]. Contact: [Contact email].",
        },
      ],
    },
  ],
};
