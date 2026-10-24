// First-run setup, in five stages (Get started, Permissions, Set up, Learn, Personalize). The
// step sequence and every rule about it live in model/onboarding.ts; the screens are in
// onboarding/. Answers stay on this Mac. Esc never closes setup; Enter continues where that is
// safe; every step moves focus to its heading.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  speakingSpeed,
  type PracticeSample,
} from "../../../shared/onboarding.ts";
import { spokenLanguages } from "../../../shared/languages.ts";
import type { AppInfo } from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  answersFromProfile,
  canContinue,
  profilePatch,
  progressFraction,
  stageStates,
  stepSequence,
  TYPICAL_SPEAKING_WPM,
  TYPING_HOURS_RANGE,
  wantsNotetaker,
  type Answers,
  type StepId,
} from "../model/onboarding.ts";
import { useToast } from "../ui/index.ts";
import { useAccount } from "../account/use-account.ts";
import { Bubble, Emphasis, PracticeStep } from "../onboarding/learn.tsx";
import { CalendarStep, PermissionsStep } from "../onboarding/permissions.tsx";
import {
  ReferralStep,
  SavingsStep,
  SpeedStep,
} from "../onboarding/personalize.tsx";
import {
  LanguagesStep,
  MicStep,
  ShortcutStep,
  TranscriptionStep,
} from "../onboarding/setup.tsx";
import {
  AccountStep,
  DataStep,
  HeardStep,
  HelpStep,
  MeetingPainStep,
  MeetingToolsStep,
  TypingStep,
  WorkStep,
} from "../onboarding/survey.tsx";
import { TopBar } from "../onboarding/frame.tsx";
import { useStatus } from "./shared.tsx";

/** Steps whose Enter key means Continue (never the ones that ask you to confirm a test). */
const ENTER_CONTINUES: ReadonlySet<StepId> = new Set([
  "heard",
  "help",
  "work",
  "typing",
  "meetingTools",
  "meetingPain",
  "data",
  "permissions",
  "calendar",
  "languages",
  "speed",
  "savings",
]);

export function Onboarding({
  settings,
  update,
  done,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  done: () => void;
}) {
  const toast = useToast();
  const { status, refresh } = useStatus();
  const account = useAccount();
  const [step, setStep] = useState<StepId>("account");
  const [answers, setAnswers] = useState<Answers>(() =>
    answersFromProfile(settings.profile),
  );
  const [codes, setCodes] = useState<string[]>(() =>
    spokenLanguages(settings.speech),
  );
  const [samples, setSamples] = useState<PracticeSample[]>([]);
  const [typingHours, setTypingHours] = useState<number>(
    TYPING_HOURS_RANGE.initial,
  );
  const [about, setAbout] = useState<AppInfo | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      void hub
        .about()
        .then(setAbout)
        .catch(() => {}),
    [],
  );

  const measured = speakingSpeed(samples).wpm;
  const seq = useMemo(
    () =>
      stepSequence({
        notetaker: wantsNotetaker(answers),
        practiced: measured !== null,
      }),
    [answers, measured],
  );
  const index = seq.indexOf(step);
  const combo = status?.shortcut.combo || settings.shortcut;

  // Each step starts at its heading, for keyboard and screen-reader users.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[data-step-heading]")?.focus();
  }, [step]);

  const save = useCallback(
    async (patch: unknown, what: string) => {
      try {
        await update(patch);
      } catch (e) {
        toast({
          title: `Couldn't save ${what}`,
          description: ipcErrorMessage(e),
          tone: "error",
        });
      }
    },
    [update, toast],
  );

  const go = (to: StepId | undefined) => to && setStep(to);
  const back = () => go(seq[Math.max(0, index - 1)]);
  const next = () => {
    // Answers and languages are saved as soon as their screens are left.
    if (step === "data")
      void save({ profile: profilePatch(answers, Date.now()) }, "your answers");
    if (step === "languages")
      void save({ speech: { languages: codes } }, "your languages");
    go(seq[index + 1]);
  };
  const skip = () => go(seq[index + 1]);

  const finish = async () => {
    setFinishing(true);
    setFinishError(null);
    try {
      await update({ onboardingCompleted: true });
      done();
    } catch (e) {
      setFinishError(ipcErrorMessage(e));
    } finally {
      setFinishing(false);
    }
  };

  // Enter = Continue where that is safe. Typing, dialogs and ordinary buttons keep their own
  // Enter; a choice chip passes it on, because Space already toggles it.
  const ready = canContinue(step, answers);
  const enterOk = ENTER_CONTINUES.has(step) && ready && seq.indexOf(step) >= 0;
  const nextRef = useRef(next);
  nextRef.current = next;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented || !enterOk) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("textarea, input, select, a, [contenteditable]")) return;
      if (t?.closest("button") && !t.closest("[data-chip]")) return;
      e.preventDefault();
      nextRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enterOk]);

  const nav = {
    onBack: index > 0 ? back : undefined,
    onNext: next,
    ready,
  };
  const common = { settings, update, status, refresh };
  const onSample = useCallback(
    (s: PracticeSample) => setSamples((all) => [...all, s]),
    [],
  );
  const practice = {
    combo,
    onBack: back,
    onSkip: skip,
    onNext: next,
    onSample,
  };
  const survey = { ...nav, answers, setAnswers };
  const signedInName =
    account?.phase === "signed-in" ? account.me?.firstName.trim() : "";

  return (
    <div ref={root} className="flex h-full flex-col bg-canvas">
      <TopBar
        stages={stageStates(seq, step)}
        progress={progressFraction(seq, step)}
        night={step === "speed" || step === "savings"}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        {step === "account" && <AccountStep {...nav} />}
        {step === "heard" && <HeardStep {...survey} />}
        {step === "help" && <HelpStep {...survey} />}
        {step === "work" && <WorkStep {...survey} />}
        {step === "typing" && <TypingStep {...survey} />}
        {step === "meetingTools" && <MeetingToolsStep {...survey} />}
        {step === "meetingPain" && <MeetingPainStep {...survey} />}
        {step === "data" && <DataStep {...nav} />}
        {step === "permissions" && (
          <PermissionsStep
            {...nav}
            status={status}
            refresh={refresh}
            about={about}
            notetaker={wantsNotetaker(answers)}
          />
        )}
        {step === "calendar" && <CalendarStep {...nav} />}
        {step === "transcription" && <TranscriptionStep {...nav} {...common} />}
        {step === "mic" && <MicStep {...nav} {...common} />}
        {step === "languages" && (
          <LanguagesStep
            {...nav}
            settings={settings}
            codes={codes}
            setCodes={setCodes}
          />
        )}
        {step === "shortcut" && <ShortcutStep {...nav} {...common} />}
        {step === "learnChat" && (
          <PracticeStep
            {...practice}
            field="practice-chat"
            appName="Messages"
            title={
              <>
                Reply to a message <Emphasis>in seconds</Emphasis>
              </>
            }
            lead="Dictate a short answer and see it appear."
            context={
              <>
                <Bubble>Are you joining the stand-up today?</Bubble>
              </>
            }
            prompt={
              <>
                Say: <i>“Yes, running ten minutes late. Start without me.”</i>
              </>
            }
            placeholder="Click here, then hold your shortcut and speak"
            rows={3}
          />
        )}
        {step === "learnEmail" && (
          <PracticeStep
            {...practice}
            field="practice-email"
            appName="New email"
            title={
              <>
                Write an email <Emphasis>by speaking</Emphasis>
              </>
            }
            lead="Murmur tidies fillers and punctuation. See what it does with a change of mind."
            context={
              <>
                <p className="text-ui text-fg-secondary">
                  <span className="font-medium text-fg">To:</span> Sam
                </p>
                <p className="text-ui text-fg-secondary">
                  <span className="font-medium text-fg">Subject:</span> Catching
                  up
                </p>
              </>
            }
            prompt={
              <>
                Say:{" "}
                <i>
                  “Umm, hi Sam. Can we find a time to talk this week? How about
                  Friday at 3, no actually, 4. Thanks
                  {signedInName ? `, ${signedInName}` : ""}.”
                </i>
              </>
            }
            placeholder="Click here, then hold your shortcut and speak"
            rows={5}
          />
        )}
        {step === "learnList" && (
          <PracticeStep
            {...practice}
            field="practice-list"
            appName="Notes"
            title={
              <>
                Make a list <Emphasis>quietly</Emphasis>
              </>
            }
            lead="Try speaking softly, the way you would in a shared office."
            prompt={
              <>
                Say, softly:{" "}
                <i>“Groceries: milk, oat bread, lemons, coffee beans.”</i>
              </>
            }
            placeholder="Click here, then hold your shortcut and speak softly"
            rows={4}
          />
        )}
        {step === "speed" && measured !== null && (
          <SpeedStep wpm={measured} onBack={back} onNext={next} />
        )}
        {step === "savings" && (
          <SavingsStep
            wpm={measured ?? TYPICAL_SPEAKING_WPM}
            measured={measured !== null}
            hours={typingHours}
            setHours={setTypingHours}
            onBack={back}
            onNext={next}
          />
        )}
        {step === "referral" && (
          <ReferralStep
            onBack={back}
            onFinish={() => void finish()}
            finishing={finishing}
            error={finishError}
          />
        )}
      </main>
    </div>
  );
}
