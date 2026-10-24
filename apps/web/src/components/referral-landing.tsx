"use client";

import Link from "next/link";
import { RULES } from "@murmur/account-api";
import { failureMessage, fetchReferral } from "../lib/api.ts";
import {
  CopyButton,
  Loading,
  Panel,
  Problem,
  Steps,
  useRemote,
} from "./landing.tsx";
import { WaitlistForm } from "./waitlist-form.tsx";

const words = RULES.referralRewardWords.toLocaleString("en-US");

const STEPS = [
  {
    title: "Get Murmur for Mac",
    body: "It isn't out yet. Leave your email below and we'll tell you when it is.",
  },
  {
    title: "Sign in with your email",
    body: "In the app, sign in under Settings, Account. A code arrives by email.",
  },
  {
    title: "Apply this code",
    body: `Open Get a free month, then Apply referral, within your first ${RULES.referralApplyWindowDays} days. You get ${RULES.referralRewardMonths} month of Pro.`,
  },
];

export function InvalidReferral() {
  return (
    <Problem
      title={
        <>
          This link <em>isn&rsquo;t valid</em>
        </>
      }
      body="The referral code may have been mistyped or is no longer in use. Ask your friend to send it again."
    />
  );
}

export function ReferralLanding({ code }: { code: string }) {
  const { result, retry } = useRemote((signal) =>
    fetchReferral(code, { signal }),
  );
  if (!result) return <Loading label="Checking your invitation" />;
  if (!result.ok) {
    return (
      <Problem
        title={
          <>
            We couldn&rsquo;t <em>check this link</em>
          </>
        }
        body={failureMessage(result.kind)}
        onRetry={retry}
      />
    );
  }
  if (!result.data.valid) return <InvalidReferral />;
  const who = result.data.firstName?.trim() || "A friend";
  return (
    <Panel
      eyebrow="A gift for you"
      title={
        <>
          {who} gifted you a <em>free month</em> of Murmur Pro
        </>
      }
    >
      <p className="mt-5 text-lg leading-relaxed text-muted">
        Murmur turns your voice into clean text in any Mac app. The month is
        applied inside the app with the code below.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <code className="rounded-full bg-modal px-5 py-2.5 font-mono text-lg tracking-widest ring-1 ring-hairline-strong">
          {code}
        </code>
        <CopyButton text={code} label="Copy code" />
      </div>
      <Steps steps={STEPS} />
      <div className="mt-12 flex flex-col items-center gap-4">
        <WaitlistForm source="referral" compact />
        <Link
          href="/download"
          className="text-sm font-semibold underline underline-offset-4"
        >
          Download details
        </Link>
      </div>
      <p className="mx-auto mt-10 max-w-lg text-sm leading-relaxed text-muted">
        Fair play: you can&rsquo;t use your own code, and a code can be applied
        once per person. {who === "A friend" ? "Your friend" : who} gets a month
        too once you have dictated {words} words over at least three days.
      </p>
    </Panel>
  );
}
