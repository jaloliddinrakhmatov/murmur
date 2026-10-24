// Insights (Stage 9A): two tabs computed from the dictations in local History on this Mac.
// "Your usage" holds speed, fixes, words, app categories and the streak calendar; "Your voice"
// unlocks after 2,000 words with local findings, and an AI-written voice profile only when the
// person asks for it. Nothing here is a sample or a comparison with other people.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AppWindow,
  Bot,
  ChevronLeft,
  ChevronRight,
  FileText,
  Info,
  Mail,
  MessageCircle,
  MessagesSquare,
  Monitor,
  Share,
  Sparkles,
  Infinity as InfinityIcon,
} from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import type { VoiceProfile } from "../../../shared/ipc.ts";
import {
  hourLabel,
  type AppCategory,
  type Insights,
} from "../../../shared/insights.ts";
import { TYPING_WPM } from "../../../shared/stats.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  EmptyState,
  InlineAlert,
  Skeleton,
  Tooltip,
  UnderlineTabs,
  cn,
  useToast,
} from "../ui/index.ts";
import { PageHeader } from "../shell/shell.tsx";
import { formatCount } from "../model/home.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { AI_LABELS } from "../model/settings.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";
import {
  calendarPage,
  categoryRows,
  gaugeFraction,
  heatLevel,
  versusTyping,
  wordsToUnlock,
} from "../model/insights.ts";

type Tab = "usage" | "voice";

export function InsightsPage({
  settings,
  openSettings,
}: {
  settings: Settings;
  openSettings: (target: SettingsTarget) => void;
}) {
  const [tab, setTab] = useState<Tab>("usage");
  const [insights, setInsights] = useState<Insights | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setInsights(await hub.insights());
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return hub.onHistoryChanged(() => void load());
  }, [load]);

  const share = async () => {
    try {
      await hub.copyInsights();
      toast({
        title: "Insights copied",
        description:
          "A summary of your totals is on the clipboard. It has none of your dictated words.",
      });
    } catch (e) {
      toast({
        title: "Couldn't copy your insights",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  return (
    <div className="relative">
      <PageHeader title="Insights" />
      {/* Beside the title without making the header taller (reference: tabs at y 172 pt). */}
      {insights && insights.dictations > 0 && (
        <div className="absolute right-0 top-[-14px]">
          <ShareButton onClick={() => void share()} />
        </div>
      )}
      <UnderlineTabs
        label="Insights"
        value={tab}
        onChange={setTab}
        options={[
          { value: "usage", label: "Your usage" },
          { value: "voice", label: "Your voice" },
        ]}
      />
      <div className="pt-8">
        {error ? (
          <InlineAlert
            tone="danger"
            icon={<AlertCircle />}
            action={
              <Button size="sm" onClick={() => void load()}>
                Try again
              </Button>
            }
          >
            Couldn't load your insights: {error}
          </InlineAlert>
        ) : !insights ? (
          <Skeleton className="h-96 rounded-list" />
        ) : insights.dictations === 0 ? (
          <section className="rounded-list border border-hairline bg-sheet">
            <EmptyState
              icon={<Sparkles className="size-5" aria-hidden />}
              title="Your insights start with your first dictation"
              description={
                settings.history.enabled
                  ? "Speed, fixes, the apps you dictate into and your streak are worked out from History on this Mac."
                  : "History is off, so dictations aren't saved and there is nothing to work out insights from."
              }
              action={
                !settings.history.enabled && (
                  <Button onClick={() => openSettings("privacy")}>
                    History settings
                  </Button>
                )
              }
            />
          </section>
        ) : tab === "usage" ? (
          <UsageTab insights={insights} />
        ) : (
          <VoiceTab
            insights={insights}
            settings={settings}
            openSettings={openSettings}
          />
        )}
      </div>
    </div>
  );
}

/** Reference: a round button with "SHARE" running around its edge. */
function ShareButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip content="Copy a summary of your totals" side="left">
      <button
        type="button"
        onClick={onClick}
        aria-label="Share insights"
        className="no-drag relative flex size-[66px] items-center justify-center rounded-full bg-surface text-fg hover:bg-surface-hover"
      >
        <svg
          viewBox="0 0 66 66"
          className="absolute inset-0 size-full motion-safe:animate-[spin_24s_linear_infinite]"
          aria-hidden
        >
          <defs>
            <path
              id="share-ring"
              d="M33,33 m-24,0 a24,24 0 1,1 48,0 a24,24 0 1,1 -48,0"
            />
          </defs>
          <text className="fill-accent-text text-[8px] font-medium tracking-[0.2em]">
            <textPath href="#share-ring">SHARE · SHARE · SHARE ·</textPath>
          </text>
        </svg>
        <Share className="size-5" aria-hidden />
      </button>
    </Tooltip>
  );
}

function Card({
  className,
  children,
  label,
}: {
  className?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "min-w-0 rounded-list border border-hairline bg-surface p-6",
        className,
      )}
    >
      {children}
    </section>
  );
}

function Stat({
  value,
  label,
  info,
}: {
  value: string;
  label: string;
  info?: string;
}) {
  return (
    <>
      <p className="text-[32px] leading-[40px] text-fg">{value}</p>
      <h2 className="mt-1 flex items-center gap-1.5 text-micro font-medium uppercase text-fg-secondary">
        {label}
        {info && (
          <Tooltip content={info} side="top">
            <button
              type="button"
              aria-label={`About ${label.toLowerCase()}`}
              className="no-drag flex size-4 items-center justify-center rounded-xs hover:text-fg"
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </Tooltip>
        )}
      </h2>
    </>
  );
}

function UsageTab({ insights }: { insights: Insights }) {
  const fixes =
    insights.fixes.dictionary + insights.fixes.snippets + insights.fixes.tidied;
  return (
    <div className="grid grid-cols-4 gap-6 max-[1100px]:grid-cols-2">
      <Card label="Speed">
        <Stat
          value={insights.wpm === null ? "—" : formatCount(insights.wpm)}
          label="Words per minute"
          info={`Words per minute while speaking: the words you said divided by the length of your recordings (recordings under a second are left out). The gauge runs to ${TYPING_WPM * 4} wpm; typing is about ${TYPING_WPM}.`}
        />
        <Gauge wpm={insights.wpm} />
      </Card>
      <Card label="Fixes">
        <Stat value={formatCount(fixes)} label="Fixes made by Murmur" />
        <dl className="mt-5 space-y-1.5 text-caption text-fg">
          {(
            [
              ["Dictionary corrections", insights.fixes.dictionary],
              ["Snippets expanded", insights.fixes.snippets],
              ["Dictations tidied", insights.fixes.tidied],
            ] as const
          ).map(([label, n]) => (
            <div key={label} className="flex justify-between gap-3">
              <dt className="text-fg-secondary">{label}</dt>
              <dd className="tabular-nums">{formatCount(n)}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card className="col-span-2" label="Words">
        <Stat
          value={formatCount(insights.words)}
          label="Total words dictated"
        />
        <div className="mt-5 flex items-start gap-2 border-t border-hairline pt-5 text-ui text-fg">
          <Monitor className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            This Mac
            <span className="block text-fg-secondary">
              {formatCount(insights.words)} words ·{" "}
              {formatCount(insights.dictations)}{" "}
              {insights.dictations === 1 ? "dictation" : "dictations"}
            </span>
          </p>
        </div>
      </Card>
      <Card className="col-span-2" label="Desktop usage">
        <CategoryCard insights={insights} />
      </Card>
      <Card className="col-span-2" label="Streak">
        <StreakCard insights={insights} />
      </Card>
    </div>
  );
}

/** A half-ring from left to right, filled to the speaking speed. */
function Gauge({ wpm }: { wpm: number | null }) {
  const f = gaugeFraction(wpm);
  const r = 58;
  const len = Math.PI * r;
  const arc = `M17,80 A${r},${r} 0 0,1 133,80`;
  const label = versusTyping(wpm);
  return (
    <div className="relative mx-auto mt-3 h-[92px] w-[150px]" aria-hidden>
      <svg viewBox="0 0 150 92" className="size-full overflow-visible">
        <path
          d={arc}
          fill="none"
          strokeWidth="13"
          strokeLinecap="round"
          className="stroke-surface-strong"
        />
        {f > 0 && (
          <path
            d={arc}
            fill="none"
            strokeWidth="13"
            strokeLinecap="round"
            strokeDasharray={`${len * f} ${len}`}
            className="stroke-accent"
          />
        )}
      </svg>
      {label && (
        <p className="absolute inset-x-0 bottom-2 text-center leading-tight text-fg">
          <span className="block text-ui font-medium">
            {label.replace(" typing", "")}
          </span>
          <span className="block text-micro text-fg-secondary">
            typing speed
          </span>
        </p>
      )}
    </div>
  );
}

const CATEGORY_ICONS: Record<AppCategory, ReactNode> = {
  other: <InfinityIcon />,
  ai: <Bot />,
  email: <Mail />,
  work: <MessagesSquare />,
  personal: <MessageCircle />,
  documents: <FileText />,
};

function CategoryCard({ insights }: { insights: Insights }) {
  const rows = categoryRows(insights);
  const topApps = insights.apps.slice(0, 3);
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-heading font-semibold text-fg">Desktop usage</h2>
        <p className="text-micro font-medium uppercase text-fg">
          Total apps used | {formatCount(insights.apps.length)}
        </p>
      </div>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.category} className="flex items-center gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center text-fg [&_svg]:size-5">
              {CATEGORY_ICONS[r.category]}
            </span>
            <span className="flex h-8 min-w-0 flex-1 items-center gap-3">
              <span
                className="flex h-full min-w-12 items-center justify-center rounded-xs bg-accent-soft text-caption font-medium text-fg"
                style={{ width: `${r.percent * 0.45}%` }}
              >
                {r.percent}%
              </span>
              <span className="truncate text-micro font-medium uppercase text-fg">
                {formatCount(r.words)} {r.words === 1 ? "word" : "words"} ·{" "}
                {r.label}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {topApps.length > 0 && (
        <p className="mt-5 flex items-start gap-2 border-t border-hairline pt-4 text-caption text-fg-secondary">
          <AppWindow className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Most used:{" "}
            {topApps
              .map((a) => `${a.name} (${formatCount(a.words)})`)
              .join(" · ")}
          </span>
        </p>
      )}
    </>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEAT = [
  "bg-surface-strong",
  "bg-accent/30",
  "bg-accent/55",
  "bg-accent/80",
  "bg-accent",
];

function StreakCard({ insights }: { insights: Insights }) {
  const [offset, setOffset] = useState(0);
  const page = calendarPage(insights.days, new Date(), offset);
  const active = page.weeks.flat().filter((d) => d.count > 0);
  const range = `${page.weeks[0][0].date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} to ${page.weeks[page.weeks.length - 1][6].date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  const days = (n: number) => `${formatCount(n)} ${n === 1 ? "day" : "days"}`;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-heading font-semibold text-fg">
          {insights.currentStreak === 0
            ? "No streak today"
            : `${days(insights.currentStreak)} streak`}
        </h2>
        <p className="text-micro font-medium uppercase text-fg">
          Longest streak | {days(insights.longestStreak)}
        </p>
      </div>
      <div className="flex items-center gap-1 text-micro text-fg-secondary">
        <button
          type="button"
          aria-label="Earlier months"
          disabled={!page.hasEarlier}
          onClick={() => setOffset((o) => o + 1)}
          className="no-drag flex size-6 items-center justify-center rounded-xs hover:text-fg disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <div className="relative h-4 flex-1" aria-hidden>
          {page.months.map((m) => (
            <span
              key={`${m.label}-${m.column}`}
              className="absolute"
              style={{ left: `${(m.column / page.weeks.length) * 100}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <button
          type="button"
          aria-label="Later months"
          disabled={!page.hasLater}
          onClick={() => setOffset((o) => Math.max(o - 1, 0))}
          className="no-drag flex size-6 items-center justify-center rounded-xs hover:text-fg disabled:opacity-40"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
      <div className="mt-3 flex gap-2" aria-hidden>
        <div className="grid shrink-0 grid-rows-7 gap-1 text-micro leading-none text-fg-secondary">
          {WEEKDAYS.map((d) => (
            <span key={d} className="flex h-3.5 items-center">
              {d}
            </span>
          ))}
        </div>
        <div className="grid flex-1 grid-flow-col grid-rows-7 gap-1">
          {page.weeks.flat().map((d) => (
            <span
              key={d.key}
              title={
                d.future
                  ? undefined
                  : `${d.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}: ${d.count} ${d.count === 1 ? "dictation" : "dictations"}`
              }
              className={cn(
                "h-3.5 rounded-[3px]",
                d.future ? "bg-transparent" : HEAT[heatLevel(d.count)],
              )}
            />
          ))}
        </div>
      </div>
      <p className="sr-only">
        {range}: dictations on {days(active.length)}
        {active.length > 0 &&
          `: ${active.map((d) => `${d.date.toLocaleDateString(undefined, { month: "long", day: "numeric" })} (${d.count})`).join(", ")}`}
        .
      </p>
      <div
        className="mt-4 flex items-center gap-1.5 text-caption text-fg-secondary"
        aria-hidden
      >
        More
        {[4, 3, 2, 1].map((l) => (
          <span key={l} className={cn("size-3.5 rounded-[3px]", HEAT[l])} />
        ))}
        Less
      </div>
    </>
  );
}

function VoiceTab({
  insights,
  settings,
  openSettings,
}: {
  insights: Insights;
  settings: Settings;
  openSettings: (target: SettingsTarget) => void;
}) {
  const remaining = wordsToUnlock(insights);
  const unlocked = remaining === 0;
  const progress = Math.min(insights.words / insights.voice.unlockAt, 1);
  const { voice } = insights;
  const locked = (
    <p className="text-ui text-fg-secondary">
      Unlocks at {formatCount(insights.voice.unlockAt)} words.
    </p>
  );
  return (
    <div className="space-y-6">
      {!unlocked && (
        <div>
          <div
            role="progressbar"
            aria-label="Voice insights progress"
            aria-valuemin={0}
            aria-valuemax={insights.voice.unlockAt}
            aria-valuenow={insights.words}
            className="h-2 overflow-hidden rounded-full bg-surface-strong"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="mt-2 text-right text-caption text-fg-secondary">
            Generates in {formatCount(remaining)} words
          </p>
          <h2 className="mt-6 text-center font-serif text-display tracking-[-0.01em] text-fg">
            Unlocks in {formatCount(remaining)} words
          </h2>
          <p className="mt-2 text-center text-lead text-fg">
            Keep dictating — your voice findings appear here, worked out on this
            Mac.
          </p>
        </div>
      )}
      <Card label="Voice Profile">
        <h2 className="font-serif text-heading text-fg">Voice Profile</h2>
        <div className="mt-3">
          {unlocked ? (
            <VoiceProfileBody settings={settings} openSettings={openSettings} />
          ) : (
            locked
          )}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-6 max-[1100px]:grid-cols-1">
        <Card label="Catchphrase">
          <h2 className="font-serif text-heading text-fg">Catchphrase</h2>
          <div className="mt-3 text-ui text-fg">
            {!unlocked
              ? locked
              : voice.catchphrase
                ? `“${voice.catchphrase}” — the three words you say together most often.`
                : "No phrase comes up three times yet."}
          </div>
        </Card>
        <Card label="Your peak time and place">
          <h2 className="font-serif text-heading text-fg">
            Your peak time &amp; place
          </h2>
          <div className="mt-3 text-ui text-fg">
            {!unlocked
              ? locked
              : voice.peakHour !== null &&
                `You dictate most around ${hourLabel(voice.peakHour)}${voice.topApp ? `, and most of all in ${voice.topApp}` : ""}.`}
          </div>
        </Card>
        <Card label="Most used words">
          <h2 className="font-serif text-heading text-fg">Most used words</h2>
          <div className="mt-3">
            {!unlocked ? (
              locked
            ) : voice.topWords.length ? (
              <ol className="flex flex-wrap gap-2">
                {voice.topWords.map((w) => (
                  <li
                    key={w.word}
                    className="rounded-full bg-accent-faint px-3 py-1 text-caption text-fg"
                  >
                    {w.word}{" "}
                    <span className="text-fg-secondary">
                      {formatCount(w.count)}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-ui text-fg-secondary">Nothing yet.</p>
            )}
          </div>
        </Card>
        <Card label="When you dictate">
          <h2 className="font-serif text-heading text-fg">When you dictate</h2>
          <div className="mt-3">
            {!unlocked ? locked : <HourChart hours={voice.hours} />}
          </div>
        </Card>
      </div>
    </div>
  );
}

function HourChart({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 1);
  return (
    <figure>
      <div className="flex h-24 items-end gap-0.5" aria-hidden>
        {hours.map((n, h) => (
          <span
            key={h}
            title={`${hourLabel(h)}: ${n}`}
            className={cn(
              "flex-1 rounded-t-[2px]",
              n ? "bg-accent" : "bg-surface-strong",
            )}
            style={{ height: `${Math.max((n / max) * 100, 4)}%` }}
          />
        ))}
      </div>
      <div
        className="mt-1 flex justify-between text-micro text-fg-secondary"
        aria-hidden
      >
        <span>12 AM</span>
        <span>6 AM</span>
        <span>12 PM</span>
        <span>6 PM</span>
      </div>
      <figcaption className="sr-only">
        Dictations by hour:{" "}
        {hours
          .map((n, h) => (n ? `${hourLabel(h)} ${n}` : null))
          .filter(Boolean)
          .join(", ")}
      </figcaption>
    </figure>
  );
}

function VoiceProfileBody({
  settings,
  openSettings,
}: {
  settings: Settings;
  openSettings: (target: SettingsTarget) => void;
}) {
  const [profile, setProfile] = useState<VoiceProfile | null | undefined>(
    undefined,
  );
  const [aiReady, setAiReady] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void hub
      .voiceProfile()
      .then(setProfile)
      .catch(() => setProfile(null));
    void hub
      .aiCleanupStatus()
      .then((s) => setAiReady(s.ready))
      .catch(() => setAiReady(undefined));
  }, [settings.cleanup.aiProvider, settings.cleanup.aiModel]);
  const service = AI_LABELS[settings.cleanup.aiProvider];

  const write = async () => {
    setBusy(true);
    setError(null);
    try {
      setProfile(await hub.generateVoiceProfile());
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (profile === undefined) return <Skeleton className="h-16" />;
  const disclosure = `Sends about 2,500 words of your most recent dictations to ${service}, the AI service in Settings → AI cleanup. The profile is kept on this Mac.`;
  return (
    <div className="space-y-3">
      {profile ? (
        <>
          <p className="max-w-[72ch] text-lead text-fg">{profile.text}</p>
          <p className="text-caption text-fg-secondary">
            Written by{" "}
            {profile.provider && Object.hasOwn(AI_LABELS, profile.provider)
              ? AI_LABELS[profile.provider as keyof typeof AI_LABELS]
              : "your AI service"}{" "}
            {new Date(profile.generatedAt).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}{" "}
            from {formatCount(profile.words)} words
          </p>
        </>
      ) : (
        <p className="text-ui text-fg">
          A few sentences on how you come across when you dictate, written by
          your AI service.
        </p>
      )}
      {error && <p className="text-caption text-danger">{error}</p>}
      {aiReady === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" loading={busy} onClick={() => void write()}>
            {profile ? "Write it again" : "Write my voice profile"}
          </Button>
          <span className="text-caption text-fg-secondary">{disclosure}</span>
        </div>
      ) : aiReady !== undefined ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={() => openSettings("ai")}>
            Set up AI service
          </Button>
          <span className="text-caption text-fg-secondary">
            The voice profile is written by the AI service you use for AI
            cleanup.
          </span>
        </div>
      ) : null}
    </div>
  );
}
