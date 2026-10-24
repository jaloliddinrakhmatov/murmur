"use client";

import { RULES } from "@murmur/account-api";
import { failureMessage, fetchInvite } from "../lib/api.ts";
import {
  CopyButton,
  Loading,
  Panel,
  Problem,
  Steps,
  useRemote,
} from "./landing.tsx";

const STEPS = [
  {
    title: "Get Murmur for Mac",
    body: "It isn't out yet. The download page lets you leave your email to be told when it is.",
  },
  {
    title: "Sign in with the invited email",
    body: "Use the address this invitation was sent to, under Settings, Account. The invite works only for that address.",
  },
  {
    title: "Paste the invite code",
    body: "Open Settings, Team, Join a team, and paste the code from your invitation email. Copy it below if you need it.",
  },
];

export function InvalidInvite() {
  return (
    <Problem
      title={
        <>
          This invite <em>isn&rsquo;t valid</em>
        </>
      }
      body="It may have been mistyped, revoked or already used. Ask your team admin to send a new one."
    />
  );
}

export function JoinLanding({ token }: { token: string }) {
  const { result, retry } = useRemote((signal) =>
    fetchInvite(token, { signal }),
  );
  if (!result) return <Loading label="Checking your invitation" />;
  if (!result.ok) {
    return (
      <Problem
        title={
          <>
            We couldn&rsquo;t <em>check this invite</em>
          </>
        }
        body={failureMessage(result.kind)}
        onRetry={retry}
      />
    );
  }
  const d = result.data;
  if (d.expired) {
    return (
      <Problem
        title={
          <>
            This invite <em>has expired</em>
          </>
        }
        body="Ask your admin for a new one. Invites last 14 days."
      />
    );
  }
  if (!d.valid) return <InvalidInvite />;
  const team = d.teamName?.trim();
  return (
    <Panel
      eyebrow="Team invite"
      title={
        <>
          You&rsquo;ve been invited to join {team ? <em>{team}</em> : "a team"}{" "}
          on Murmur
        </>
      }
    >
      <p className="mt-5 text-lg leading-relaxed text-muted">
        Joining takes a few steps in the app. Teams start with a{" "}
        {RULES.teamTrialDays}-day Pro trial.
      </p>
      <Steps steps={STEPS} />
      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <CopyButton text={token} label="Copy invite code" />
      </div>
    </Panel>
  );
}
