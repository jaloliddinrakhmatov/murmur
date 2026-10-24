// GET STARTED: sign in (optional), the short survey, and how your data is handled. Answers are
// kept on this Mac only; nothing here is sent anywhere.
import type { ReactNode } from "react";
import {
  Code,
  Ellipsis,
  FileText,
  Globe,
  Mail,
  MessageSquare,
  Share2,
  StickyNote,
} from "lucide-react";
import { Button } from "../ui/index.ts";
import { openSignIn } from "../account/ui.tsx";
import { useAccount } from "../account/use-account.ts";
import {
  HEARD_FROM_OPTIONS,
  MEETING_PAIN_OPTIONS,
  MEETING_TOOL_OPTIONS,
  TYPING_PLACE_OPTIONS,
  USE_OPTIONS,
  WORK_OPTIONS,
  toggle,
  type Answers,
  type Option,
} from "../model/onboarding.ts";
import { ArtDesk, ArtShield, ArtVoice, HelpPreviews } from "./art.tsx";
import { Chip, ChipGroup, ContinueButton, SplitScreen } from "./frame.tsx";

export interface StepNav {
  onBack?: () => void;
  onNext: () => void;
  ready: boolean;
}

interface AnswerProps extends StepNav {
  answers: Answers;
  setAnswers: (a: Answers) => void;
}

const STAYS = "Your answers stay on this Mac.";

export function AccountStep({ onBack, onNext }: StepNav) {
  const account = useAccount();
  const signedIn = account?.phase === "signed-in" && account.me;
  const restoring = !account || account.phase === "restoring";
  const name = signedIn
    ? account.me!.firstName.trim() || account.me!.email.split("@")[0]
    : null;
  return (
    <SplitScreen
      title={signedIn ? `Welcome, ${name}!` : "Welcome to Murmur"}
      lead={
        signedIn
          ? "You're signed in. Dictation still runs on this Mac; your account is for inviting a team and free months."
          : "Hold a shortcut, speak, and your words appear wherever you type. An account is optional: it's only for inviting a team and referral rewards."
      }
      onBack={onBack}
      art={<ArtVoice />}
      footer={
        signedIn ? (
          <ContinueButton onClick={onNext} />
        ) : (
          <div className="space-y-3">
            {account?.keychain !== "unavailable" && (
              <ContinueButton
                onClick={openSignIn}
                disabled={restoring}
                loading={restoring}
              >
                Sign in with email
              </ContinueButton>
            )}
            <Button
              variant={
                account?.keychain === "unavailable" ? "primary" : "outline"
              }
              size="lg"
              className="w-full"
              onClick={onNext}
            >
              Continue without an account
            </Button>
          </div>
        )
      }
    >
      {!signedIn && account?.keychain === "unavailable" && (
        <p className="text-ui text-fg-secondary">
          Signing in needs the macOS Keychain, which isn't available right now.
          Murmur works fully without an account.
        </p>
      )}
    </SplitScreen>
  );
}

function Choice({
  title,
  lead,
  options,
  value,
  multi,
  onChange,
  nav,
  art,
  icons,
}: {
  title: string;
  lead: ReactNode;
  options: readonly Option[];
  value: string[];
  multi: boolean;
  onChange: (v: string[]) => void;
  nav: StepNav;
  art: ReactNode;
  icons?: Record<string, ReactNode>;
}) {
  return (
    <SplitScreen
      title={title}
      lead={lead}
      onBack={nav.onBack}
      art={art}
      footer={<ContinueButton onClick={nav.onNext} disabled={!nav.ready} />}
    >
      <ChipGroup label={title}>
        {options.map((o) => (
          <Chip
            key={o.id}
            selected={value.includes(o.id)}
            icon={icons?.[o.id]}
            onClick={() => onChange(multi ? toggle(value, o.id) : [o.id])}
          >
            {o.label}
          </Chip>
        ))}
      </ChipGroup>
    </SplitScreen>
  );
}

export function HeardStep(p: AnswerProps) {
  return (
    <Choice
      title="Where did you hear about Murmur?"
      lead={`Pick one. ${STAYS}`}
      options={HEARD_FROM_OPTIONS}
      value={p.answers.heardFrom ? [p.answers.heardFrom] : []}
      multi={false}
      onChange={(v) => p.setAnswers({ ...p.answers, heardFrom: v[0] ?? null })}
      nav={p}
      art={<ArtDesk />}
    />
  );
}

export function HelpStep(p: AnswerProps) {
  return (
    <SplitScreen
      title="How can Murmur help you?"
      lead={`Choose what you want. You can use both. ${STAYS}`}
      onBack={p.onBack}
      art={
        <HelpPreviews
          dictation={p.answers.uses.includes("dictation")}
          notetaker={p.answers.uses.includes("notetaker")}
        />
      }
      footer={<ContinueButton onClick={p.onNext} disabled={!p.ready} />}
    >
      <ChipGroup label="How can Murmur help you?">
        {USE_OPTIONS.map((o) => (
          <Chip
            key={o.id}
            selected={p.answers.uses.includes(o.id)}
            onClick={() =>
              p.setAnswers({ ...p.answers, uses: toggle(p.answers.uses, o.id) })
            }
          >
            {o.label}
          </Chip>
        ))}
      </ChipGroup>
    </SplitScreen>
  );
}

export function WorkStep(p: AnswerProps) {
  return (
    <Choice
      title="What do you do for work?"
      lead={`Pick the closest one. ${STAYS}`}
      options={WORK_OPTIONS}
      value={p.answers.work ? [p.answers.work] : []}
      multi={false}
      onChange={(v) => p.setAnswers({ ...p.answers, work: v[0] ?? null })}
      nav={p}
      art={<ArtDesk />}
    />
  );
}

const TYPING_ICONS: Record<string, ReactNode> = {
  email: <Mail className="size-4" />,
  messages: <MessageSquare className="size-4" />,
  docs: <FileText className="size-4" />,
  notes: <StickyNote className="size-4" />,
  coding: <Code className="size-4" />,
  browser: <Globe className="size-4" />,
  social: <Share2 className="size-4" />,
  other: <Ellipsis className="size-4" />,
};

export function TypingStep(p: AnswerProps) {
  return (
    <Choice
      title="Where do you spend time typing?"
      lead={`Select all that apply. ${STAYS}`}
      options={TYPING_PLACE_OPTIONS}
      value={p.answers.typingPlaces}
      multi
      onChange={(v) => p.setAnswers({ ...p.answers, typingPlaces: v })}
      nav={p}
      art={<ArtDesk />}
      icons={TYPING_ICONS}
    />
  );
}

export function MeetingToolsStep(p: AnswerProps) {
  return (
    <Choice
      title="How do you record meetings today?"
      lead={`Select all that apply. ${STAYS}`}
      options={MEETING_TOOL_OPTIONS}
      value={p.answers.meetingTools}
      multi
      onChange={(v) => p.setAnswers({ ...p.answers, meetingTools: v })}
      nav={p}
      art={<ArtVoice />}
    />
  );
}

export function MeetingPainStep(p: AnswerProps) {
  return (
    <Choice
      title="What's frustrating about meetings?"
      lead={`Select all that apply. ${STAYS}`}
      options={MEETING_PAIN_OPTIONS}
      value={p.answers.meetingPains}
      multi
      onChange={(v) => p.setAnswers({ ...p.answers, meetingPains: v })}
      nav={p}
      art={<ArtVoice />}
    />
  );
}

export function DataStep({ onBack, onNext }: StepNav) {
  const facts: [string, string][] = [
    [
      "Murmur never trains on your data.",
      "Nothing you say or write is used to train a model by Murmur.",
    ],
    [
      "Your library stays on this Mac.",
      "History, dictionary, snippets, notes and your answers here are stored locally.",
    ],
    [
      "Audio goes only to your transcription service.",
      "The service you choose in Settings receives each recording to turn it into text. Murmur has no server that stores audio.",
    ],
    [
      "AI cleanup is off until you turn it on.",
      "If you do, the text (not the audio) goes to the AI service you pick.",
    ],
  ];
  return (
    <SplitScreen
      title="You're in control of your data"
      onBack={onBack}
      art={<ArtShield />}
      footer={<ContinueButton onClick={onNext} />}
    >
      <ul className="space-y-4">
        {facts.map(([head, body]) => (
          <li key={head}>
            <p className="text-ui font-semibold text-fg">{head}</p>
            <p className="mt-0.5 text-ui text-fg-secondary">{body}</p>
          </li>
        ))}
      </ul>
    </SplitScreen>
  );
}
