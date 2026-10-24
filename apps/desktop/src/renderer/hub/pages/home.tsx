// Dictation (route `home`): the reference's main page. Greeting with the live shortcut, a
// dismissible banner with a real action, the complete History feed (filters, search, details,
// retry, copy, delete, export) and a totals card. Every number comes from the SQLite History on
// this Mac (see shared/stats.ts); with no data there is an empty state, never placeholder figures.
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ClipboardCopy, Info, Mic } from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import {
  estimateTimeSavedMs,
  TYPING_WPM,
  type HistoryStats,
} from "../../../shared/stats.ts";
import { hub } from "../bridge.ts";
import {
  Banner,
  Button,
  EmptyState,
  InlineAlert,
  Kbd,
  Skeleton,
  Tooltip,
} from "../ui/index.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";
import { useStatus } from "./shared.tsx";
import {
  formatCount,
  formatDuration,
  greeting,
  readiness,
  timeSavedLabel,
  type ReadinessItem,
} from "../model/home.ts";
import { SPEECH_LABELS } from "../model/settings.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { HistoryFeed } from "./history.tsx";
import { useDismissed } from "./library.tsx";

const FIX_LABEL: Record<ReadinessItem["key"], string> = {
  microphone: "Allow microphone",
  shortcut: "Fix shortcut",
  transcription: "Set up transcription",
  accessibility: "Allow pasting",
};

export function DictationPage({
  settings,
  update,
  openSettings,
  focusId,
  onFocusHandled,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  openSettings: (target: SettingsTarget) => void;
  focusId?: string;
  onFocusHandled?: () => void;
}) {
  const { status } = useStatus();
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [bannerDismissed, dismissBanner] = useDismissed("dictation");

  const load = useCallback(async () => {
    try {
      setStats(await hub.historyStats());
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
    return hub.onHistoryChanged(() => void load());
  }, [load]);

  const combo = status?.shortcut.combo || settings.shortcut;
  const items = status
    ? readiness(status, SPEECH_LABELS[settings.speech.provider])
    : null;
  const hasData = Boolean(stats && stats.dictations > 0);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_250px] gap-x-6 max-[1100px]:grid-cols-1">
      <h1 className="col-span-full mb-[27px] flex flex-wrap items-center gap-x-2 gap-y-1 text-title font-semibold text-fg">
        {greeting(new Date())}, hold
        <Kbd combo={combo} size="lg" />
        to dictate
      </h1>

      <div className="min-w-0 space-y-6 max-[1100px]:order-2">
        {status && !status.permissions.accessibility && (
          <InlineAlert
            tone="warning"
            icon={<ClipboardCopy />}
            action={
              <Button size="sm" onClick={() => openSettings("system")}>
                Allow pasting
              </Button>
            }
          >
            Automatic pasting is off, so each dictation is copied instead —
            press ⌘V to paste it.
          </InlineAlert>
        )}
        {!bannerDismissed && (
          <Banner
            scene="dictation"
            title="Murmur works anywhere you type"
            onDismiss={dismissBanner}
            actions={
              <Button
                variant="banner"
                onClick={() => openSettings("shortcuts")}
              >
                Change shortcut
              </Button>
            }
          >
            <p>
              Click into any text field, hold your shortcut, speak, and release.
            </p>
          </Banner>
        )}
        <HistoryFeed
          settings={settings}
          update={update}
          openSettings={openSettings}
          focusId={focusId}
          onFocusHandled={onFocusHandled}
          firstRun={
            <FirstRun
              combo={combo}
              items={items}
              historyEnabled={settings.history.enabled}
              openSettings={openSettings}
            />
          }
        />
      </div>

      <aside
        aria-label="Totals"
        className="min-w-0 max-[1100px]:order-1 max-[1100px]:mb-6"
      >
        {error ? (
          <InlineAlert
            tone="danger"
            icon={<AlertCircle />}
            action={
              <Button
                size="sm"
                loading={retrying}
                onClick={async () => {
                  setRetrying(true);
                  await load();
                  setRetrying(false);
                }}
              >
                Try again
              </Button>
            }
          >
            Couldn't load your totals: {error}
          </InlineAlert>
        ) : !stats ? (
          <Skeleton className="h-72 rounded-list" />
        ) : hasData ? (
          <TotalsCard
            stats={stats}
            historyEnabled={settings.history.enabled}
            openSettings={openSettings}
          />
        ) : null}
      </aside>
    </div>
  );
}

/** Reference stats card: serif numbers with labels, a divider, then a smaller sub-panel. */
function TotalsCard({
  stats,
  historyEnabled,
  openSettings,
}: {
  stats: HistoryStats;
  historyEnabled: boolean;
  openSettings: (target: SettingsTarget) => void;
}) {
  const since = stats.firstAt
    ? new Date(stats.firstAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;
  // Reference rows: total words, wpm, day streak. Each is computed from History on demand;
  // wpm is left out until there is a dictation it can be measured from.
  const rows: { value: string; label: string; info?: string }[] = [
    { value: formatCount(stats.words), label: "total words" },
    ...(stats.wpm === null
      ? []
      : [
          {
            value: formatCount(stats.wpm),
            label: "wpm",
            info: "Words per minute while speaking: the words you said (before cleanup and snippets) divided by the length of your recordings. Recordings under a second are left out.",
          },
        ]),
    {
      value: formatCount(stats.streakDays),
      label: "day streak",
      info: "Days in a row, up to today, with at least one dictation that was inserted or copied. Today doesn't break it until it ends.",
    },
  ];
  return (
    // Narrow windows: one compact band (totals in a row, last 7 days beside them).
    <section className="overflow-hidden rounded-list border border-hairline bg-surface max-[1100px]:flex max-[1100px]:flex-wrap max-[1100px]:items-center">
      <dl className="space-y-3 px-6 pb-6 pt-7 max-[1100px]:flex max-[1100px]:flex-1 max-[1100px]:flex-wrap max-[1100px]:gap-x-6 max-[1100px]:space-y-0 max-[1100px]:py-4">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2.5">
            {/* Only dt/dd inside the row (valid list); CSS shows the number first. */}
            <dt className="order-2 inline-flex items-baseline gap-2.5 text-ui text-fg">
              {r.label}
              {r.info && (
                <Tooltip content={r.info} side="top">
                  <button
                    type="button"
                    aria-label={`About ${r.label}`}
                    className="no-drag flex size-4 items-center justify-center self-center rounded-xs text-fg-secondary hover:text-fg"
                  >
                    <Info className="size-3.5" aria-hidden />
                  </button>
                </Tooltip>
              )}
            </dt>
            <dd className="order-1 font-serif text-number tracking-[-0.01em] text-fg">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-hairline px-6 pb-6 pt-5 max-[1100px]:border-t-0 max-[1100px]:py-4">
        <h2 className="text-ui font-semibold text-fg">Last 7 days</h2>
        <p className="mt-1 text-caption text-fg">
          {formatCount(stats.lastWeek.dictations)}{" "}
          {stats.lastWeek.dictations === 1 ? "dictation" : "dictations"} ·{" "}
          {formatCount(stats.lastWeek.words)} words
        </p>
        <p className="mt-3 flex items-center gap-1.5 text-caption text-fg">
          Time saved: {timeSavedLabel(estimateTimeSavedMs(stats))}
          <Tooltip
            content={`Estimate: the time to type these ${formatCount(stats.words)} words at ${TYPING_WPM} words per minute, minus the ${formatDuration(stats.speakingMs)} you spent speaking. Editing time is not included.`}
            side="top"
          >
            <button
              type="button"
              aria-label="How time saved is estimated"
              className="no-drag flex size-4 items-center justify-center rounded-xs text-fg-secondary hover:text-fg"
            >
              <Info className="size-3.5" aria-hidden />
            </button>
          </Tooltip>
        </p>
        {historyEnabled ? (
          <p className="mt-3 text-caption text-fg-secondary">
            From History on this Mac{since ? ` since ${since}` : ""}
          </p>
        ) : (
          <button
            type="button"
            onClick={() => openSettings("privacy")}
            className="no-drag mt-3 text-left text-caption font-medium text-warning hover:underline"
          >
            History is off, so new dictations aren't counted
          </button>
        )}
      </div>
    </section>
  );
}

function FirstRun({
  combo,
  items,
  historyEnabled,
  openSettings,
}: {
  combo: string;
  items: ReadinessItem[] | null;
  historyEnabled: boolean;
  openSettings: (target: SettingsTarget) => void;
}) {
  const blocker = items?.find((i) => i.blocking);
  return (
    <section
      aria-label="Get started"
      className="rounded-list border border-hairline bg-sheet"
    >
      <EmptyState
        icon={<Mic className="size-5" aria-hidden />}
        title="Your first dictation is one shortcut away"
        description={
          <>
            Click into any text field, hold{" "}
            <Kbd combo={combo} className="align-middle" />, speak, and release.
            Your dictations and totals will appear here.
            {!historyEnabled &&
              " History is off, so dictations won't be saved or counted."}
          </>
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {blocker && (
              <Button
                variant="primary"
                onClick={() => openSettings(blocker.section)}
              >
                {FIX_LABEL[blocker.key]}
              </Button>
            )}
            {blocker?.key !== "microphone" && (
              <Button onClick={() => openSettings("microphone")}>
                Microphone settings
              </Button>
            )}
          </div>
        }
      />
    </section>
  );
}
