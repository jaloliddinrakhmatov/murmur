// PERSONALIZE: how fast you spoke compared with typing, an estimate of time saved, and the
// referral code. Numbers come from the practice dictations or are labelled as estimates.
import { useEffect, useId, useState } from "react";
import { Copy, Gift } from "lucide-react";
import { RULES } from "@murmur/account-api";
import { hub } from "../bridge.ts";
import { openSignIn } from "../account/ui.tsx";
import { refreshAccount, useAccount } from "../account/use-account.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { referralShareText } from "../model/account.ts";
import { weeklyTimeSaved } from "../../../shared/onboarding.ts";
import {
  hoursText,
  savingsMethod,
  speedText,
  TYPING_HOURS_RANGE,
} from "../model/onboarding.ts";
import { Button, Skeleton, useToast } from "../ui/index.ts";
import { OfflineNotice } from "../account/offline.tsx";
import { CenterScreen } from "./frame.tsx";
import { Card } from "./setup.tsx";
import type { StepNav } from "./survey.tsx";

export function SpeedStep({
  wpm,
  onBack,
  onNext,
}: Omit<StepNav, "ready"> & { wpm: number }) {
  const t = speedText(wpm);
  return (
    <CenterScreen
      dark
      title="Nice job!"
      lead="Here's how your speaking speed compares with typing."
      onBack={onBack}
    >
      <div className="mx-auto max-w-[520px] text-center">
        <p className="font-serif text-[88px] leading-none tracking-[-0.02em]">
          {wpm}
        </p>
        <p className="mt-2 text-lead">words per minute</p>
        <p className="mt-8 font-serif text-display">{t.headline}</p>
        <p className="mx-auto mt-3 max-w-[440px] text-ui text-night-fg-secondary">
          {t.detail}
        </p>
        <Button
          variant="ghost"
          size="lg"
          className="mt-10 min-w-48 !bg-night-fg !text-night hover:!bg-night-fg/90"
          onClick={onNext}
        >
          Continue
        </Button>
      </div>
    </CenterScreen>
  );
}

export function SavingsStep({
  wpm,
  measured,
  hours,
  setHours,
  onBack,
  onNext,
}: Omit<StepNav, "ready"> & {
  wpm: number;
  measured: boolean;
  hours: number;
  setHours: (h: number) => void;
}) {
  const id = useId();
  const saved = weeklyTimeSaved({
    typingHoursPerDay: hours,
    speakingWpm: wpm,
  }).hoursPerWeek;
  return (
    <CenterScreen
      dark
      title={
        saved > 0
          ? `You could save about ${hoursText(saved)} a week`
          : "Dictation may not save you time yet"
      }
      lead="Slide to how long you spend typing on a typical workday."
      onBack={onBack}
    >
      <div className="mx-auto max-w-[520px] text-center">
        <label htmlFor={id} className="text-ui font-medium">
          Typing per day: {hoursText(hours)}
        </label>
        <input
          id={id}
          type="range"
          min={TYPING_HOURS_RANGE.min}
          max={TYPING_HOURS_RANGE.max}
          step={TYPING_HOURS_RANGE.step}
          value={hours}
          aria-valuetext={`${hoursText(hours)} a day`}
          onChange={(e) => setHours(Number(e.target.value))}
          className="no-drag mt-4 h-2 w-full cursor-pointer accent-accent"
        />
        <div className="mt-1 flex justify-between text-caption text-night-fg-secondary">
          <span>{hoursText(TYPING_HOURS_RANGE.min)}</span>
          <span>{hoursText(TYPING_HOURS_RANGE.max)}</span>
        </div>
        <p className="mx-auto mt-8 max-w-[440px] text-ui text-night-fg-secondary">
          {savingsMethod(wpm, measured)}
        </p>
        <Button
          variant="ghost"
          size="lg"
          className="mt-10 min-w-48 !bg-night-fg !text-night hover:!bg-night-fg/90"
          onClick={onNext}
        >
          Continue
        </Button>
      </div>
    </CenterScreen>
  );
}

export function ReferralStep({
  onBack,
  onFinish,
  finishing,
  error,
}: {
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
  error: string | null;
}) {
  const account = useAccount();
  const toast = useToast();
  const signedIn = account?.phase === "signed-in";
  useEffect(() => {
    if (signedIn) void refreshAccount();
  }, [signedIn]);
  const [copyError, setCopyError] = useState<string | null>(null);
  const code = account?.referrals?.code ?? null;
  const months = RULES.referralRewardMonths;
  const copy = async () => {
    if (!code) return;
    setCopyError(null);
    try {
      await hub.copyText(referralShareText(code));
      toast({ title: "Code copied", tone: "success" });
    } catch (e) {
      setCopyError(ipcErrorMessage(e));
    }
  };
  return (
    <CenterScreen
      title="Give a free month, get a free month"
      lead={
        signedIn
          ? `Share your code. Your friend gets ${months} month of Murmur Pro, and so do you once they've dictated ${RULES.referralRewardWords.toLocaleString("en-US")} words.`
          : "Referral codes belong to a Murmur account. Dictation and everything else works without one."
      }
      onBack={onBack}
    >
      <Card className="space-y-4 text-center">
        {signedIn ? (
          <>
            {account?.offline && <OfflineNotice />}
            {code ? (
              <>
                <p className="text-micro uppercase text-fg-secondary">
                  Your referral code
                </p>
                <p className="font-serif text-display tracking-wide text-fg">
                  {code}
                </p>
                <Button
                  icon={<Copy className="size-4" aria-hidden />}
                  onClick={() => void copy()}
                >
                  Copy code
                </Button>
                {copyError && (
                  <p role="alert" className="text-caption text-danger">
                    {copyError}
                  </p>
                )}
              </>
            ) : account?.offline ? null : (
              <Skeleton className="mx-auto h-16 w-48" />
            )}
          </>
        ) : (
          <>
            <Gift aria-hidden className="mx-auto size-6 text-fg-secondary" />
            <p className="text-ui font-semibold text-fg">
              Sign in to get your referral code
            </p>
            <Button variant="outline" onClick={openSignIn}>
              Sign in with email
            </Button>
          </>
        )}
      </Card>
      <div className="mx-auto mt-6 max-w-[520px]">
        {error && (
          <p role="alert" className="mb-3 text-center text-ui text-danger">
            Couldn't finish setup: {error}
          </p>
        )}
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          loading={finishing}
          onClick={onFinish}
        >
          Finish
        </Button>
      </div>
    </CenterScreen>
  );
}
