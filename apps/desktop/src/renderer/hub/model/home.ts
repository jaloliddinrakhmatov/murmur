// Pure Home screen logic (no React), unit-tested under Node (test/home.test.ts).
import type { DictationRow, StatusInfo } from "../../../shared/ipc.ts";
import type { Tone } from "./tone.ts";
import type { SettingsTarget } from "./settings-sections.ts";

export interface ReadinessItem {
  key: "microphone" | "shortcut" | "transcription" | "accessibility";
  tone: Tone;
  label: string;
  /** Where the fix lives. */
  section: SettingsTarget;
  /** True when dictation cannot work until this is fixed. */
  blocking: boolean;
}

const MICROPHONE: Record<
  StatusInfo["permissions"]["microphone"],
  Pick<ReadinessItem, "tone" | "label" | "blocking">
> = {
  granted: { tone: "success", label: "Microphone ready", blocking: false },
  "not-determined": {
    tone: "warning",
    label: "Microphone not allowed yet",
    blocking: true,
  },
  denied: { tone: "danger", label: "Microphone blocked", blocking: true },
  restricted: {
    tone: "danger",
    label: "Microphone restricted by macOS",
    blocking: true,
  },
  unknown: {
    tone: "neutral",
    label: "Microphone status unknown",
    blocking: false,
  },
};

/** Readiness, in the order a new user has to fix things. Accessibility only shows when off. */
export function readiness(
  status: StatusInfo,
  providerLabel: string,
): ReadinessItem[] {
  const items: ReadinessItem[] = [
    {
      key: "microphone",
      section: "microphone",
      ...MICROPHONE[status.permissions.microphone],
    },
    status.shortcut.registered
      ? {
          key: "shortcut",
          section: "shortcuts",
          tone: "success",
          label: "Shortcut active",
          blocking: false,
        }
      : {
          key: "shortcut",
          section: "shortcuts",
          tone: "danger",
          label: "Shortcut unavailable",
          blocking: true,
        },
    status.providerReady
      ? {
          key: "transcription",
          section: "transcription",
          tone: "danger",
          label: "Transcription not set up",
          blocking: true,
        }
      : {
          key: "transcription",
          section: "transcription",
          tone: "success",
          label: providerLabel,
          blocking: false,
        },
  ];
  if (!status.permissions.accessibility)
    items.push({
      key: "accessibility",
      section: "system",
      tone: "warning",
      label: "Copying instead of pasting",
      blocking: false,
    });
  return items;
}

/** Rows worth showing on Home: cancelled and silent recordings have nothing to act on. */
export function recentRows(rows: DictationRow[], limit = 5): DictationRow[] {
  return rows
    .filter((r) => r.status !== "cancelled" && r.status !== "empty")
    .slice(0, limit);
}

export const RECENT_STATUS: Record<
  DictationRow["status"],
  { tone: Tone; label: string }
> = {
  inserted: { tone: "success", label: "Inserted" },
  copied: { tone: "warning", label: "Copied" },
  rejected: { tone: "danger", label: "Not inserted" },
  failed: { tone: "danger", label: "Failed" },
  transcribing: { tone: "neutral", label: "Transcribing…" },
  empty: { tone: "neutral", label: "Nothing heard" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

/** "Morning" until noon, "afternoon" until 6 pm, "evening" otherwise (local time). */
export function greeting(now: Date): string {
  const h = now.getHours();
  return h >= 5 && h < 12
    ? "Good morning"
    : h >= 12 && h < 18
      ? "Good afternoon"
      : "Good evening";
}

/** "2:14 PM", "Yesterday, 11:26 PM", or "Oct 14, 11:26 PM" (adds the year when it differs). */
export function whenLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return time;
  if (d.toDateString() === yesterday.toDateString())
    return `Yesterday, ${time}`;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
  return `${date}, ${time}`;
}

/** "< 1 min", "12 min", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The estimate's headline: "< 1 min" stays exact-looking, larger values get "≈". */
export function timeSavedLabel(ms: number): string {
  return ms < 60_000 ? "< 1 min" : `≈ ${formatDuration(ms)}`;
}

export const formatCount = (n: number) => n.toLocaleString();
