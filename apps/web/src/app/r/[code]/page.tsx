import type { Metadata } from "next";
import { ReferralCodeSchema } from "@murmur/account-api";
import {
  InvalidReferral,
  ReferralLanding,
} from "../../../components/referral-landing.tsx";

export const metadata: Metadata = {
  title: "A gift from a friend",
  description: "A friend gifted you a free month of Murmur Pro.",
  robots: { index: false },
  referrer: "no-referrer",
};

export default async function Page({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const parsed = ReferralCodeSchema.safeParse(code);
  if (!parsed.success) return <InvalidReferral />;
  return <ReferralLanding code={parsed.data} />;
}
