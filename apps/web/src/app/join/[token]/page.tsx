import type { Metadata } from "next";
import {
  InvalidInvite,
  JoinLanding,
} from "../../../components/join-landing.tsx";
import { isInviteTokenShape } from "../../../lib/api.ts";

export const metadata: Metadata = {
  title: "Team invite",
  description: "You've been invited to a team on Murmur.",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isInviteTokenShape(token)) return <InvalidInvite />;
  return <JoinLanding token={token} />;
}
