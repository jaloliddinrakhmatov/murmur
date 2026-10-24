// Pure History screen logic (no React), unit-tested under Node (test/history.test.ts).
import type { DictationRow } from "../../../shared/ipc.ts";
import type { Tone } from "./tone.ts";
import { redactSecrets } from "../../../shared/redact.ts";

type Status = DictationRow["status"];

export const HISTORY_FILTERS = [
  { id: "all", label: "All", statuses: undefined },
  { id: "inserted", label: "Inserted", statuses: ["inserted"] },
  { id: "copied", label: "Copied", statuses: ["copied"] },
  {
    id: "issues",
    label: "Issues",
    statuses: ["failed", "rejected", "empty", "cancelled"],
  },
] as const satisfies readonly {
  id: string;
  label: string;
  statuses: readonly Status[] | undefined;
}[];

export type HistoryFilter = (typeof HISTORY_FILTERS)[number]["id"];

export function filterStatuses(filter: HistoryFilter): Status[] | undefined {
  const f = HISTORY_FILTERS.find((x) => x.id === filter);
  return f?.statuses ? [...f.statuses] : undefined;
}

/** "Today", "Yesterday", "Wednesday, October 14" (with the year only when it differs). */
export function dayLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Consecutive rows (newest first) grouped by local day. */
export function groupByDay<T extends { startedAt: number }>(
  rows: T[],
  now: Date,
): { label: string; rows: T[] }[] {
  const groups: { label: string; rows: T[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.startedAt, now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(r);
    else groups.push({ label, rows: [r] });
  }
  return groups;
}

/** Why a dictation ended on the clipboard instead of being pasted (insertion `reason`). */
const COPIED_WHY: Record<string, string> = {
  "self-target":
    "Murmur itself was in front when you dictated, so the text was copied. Paste it with ⌘V.",
  "target-changed":
    "You switched apps before the text was ready, so it was copied. Paste it with ⌘V.",
  "paste-unavailable":
    "Pasting wasn't available (check Accessibility in Settings), so the text was copied. Paste it with ⌘V.",
  default:
    "The text was copied to the clipboard instead of pasted. Paste it with ⌘V.",
};

/**
 * One status per row: a short label for the list, plus an explanation only when it adds
 * something the label doesn't say (never "Inserted · Inserted").
 */
export function statusInfo(row: DictationRow): {
  tone: Tone;
  label: string;
  explanation: string | null;
} {
  switch (row.status) {
    case "inserted":
      return { tone: "success", label: "Inserted", explanation: null };
    case "copied":
      return {
        tone: "warning",
        label: "Copied",
        explanation: COPIED_WHY[row.error ?? ""] ?? COPIED_WHY.default,
      };
    case "rejected":
      return {
        tone: "danger",
        label: "Not inserted",
        explanation:
          row.error === "secure-field"
            ? "The cursor was in a password field, so Murmur didn't type or copy anything."
            : "Murmur couldn't insert the text into the app.",
      };
    case "failed":
      return { tone: "danger", label: "Failed", explanation: null };
    case "empty":
      return {
        tone: "neutral",
        label: "Nothing heard",
        explanation: "The recording had no words in it.",
      };
    case "cancelled":
      return { tone: "neutral", label: "Cancelled", explanation: null };
    default:
      return { tone: "neutral", label: "Transcribing…", explanation: null };
  }
}

export { redactSecrets };

const HTTP_MESSAGES: Record<number, string> = {
  400: "The transcription service rejected the recording.",
  401: "The transcription service didn't accept your API key. Check Settings → Transcription.",
  402: "The transcription account needs payment or credits.",
  403: "The transcription service refused the request. Check your API key and plan.",
  404: "The transcription model wasn't found. Check the model in Settings → Transcription.",
  408: "The transcription service didn't answer in time.",
  413: "The recording was too large for the transcription service.",
  429: "The transcription service's rate limit or credits ran out.",
};

/**
 * A plain-language reason for a failure, plus the raw text (secrets redacted) for anyone who
 * wants the technical details. Null when the row has no error worth showing.
 */
export function friendlyError(
  row: DictationRow,
): { summary: string; details: string | null } | null {
  const raw = row.error?.trim();
  if (!raw || row.status !== "failed") return null;
  if (raw === "timeout")
    return {
      summary: "The transcription service didn't answer in time.",
      details: null,
    };
  if (raw === "audio no longer available")
    return {
      summary: "The recording is no longer stored, so it can't be transcribed.",
      details: null,
    };
  if (raw.startsWith("too-long:"))
    return {
      summary:
        "This recording is too long for the transcription service it was sent to. Switch the service in Settings, then retry.",
      details: redactSecrets(raw.slice("too-long:".length).trim()),
    };
  if (raw.startsWith("not-configured:"))
    return {
      summary: "Transcription isn't set up.",
      details: redactSecrets(raw.slice("not-configured:".length).trim()),
    };
  const code = /\bHTTP (\d{3})\b/.exec(raw);
  if (code) {
    const n = Number(code[1]);
    return {
      summary:
        HTTP_MESSAGES[n] ??
        (n >= 500
          ? "The transcription service had a problem on its side."
          : "The transcription service returned an error."),
      details: redactSecrets(raw),
    };
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(raw))
    return {
      summary: "Murmur couldn't reach the transcription service.",
      details: redactSecrets(raw),
    };
  return {
    summary: "Transcription failed.",
    details: redactSecrets(raw),
  };
}

/**
 * Whether the stored (encrypted) recording can be transcribed again. Audio is kept only for
 * rows that weren't inserted, and only until the retention period ends.
 */
export function retryInfo(
  row: DictationRow,
  currentProvider?: string,
): {
  canRetry: boolean;
  label: string;
  unavailable: string | null;
} {
  if (row.status === "transcribing")
    return { canRetry: false, label: "Transcribing…", unavailable: null };
  // Too long for the service it went to: retrying there fails the same way until it is switched.
  if (
    row.hasAudio &&
    row.error?.startsWith("too-long:") &&
    row.provider === currentProvider
  )
    return {
      canRetry: false,
      label: "Retry transcription",
      unavailable:
        "This recording is too long for the current transcription service. Switch the service in Settings, then retry.",
    };
  if (row.hasAudio)
    return {
      canRetry: true,
      label:
        row.status === "failed" ? "Retry transcription" : "Transcribe again",
      unavailable: null,
    };
  return {
    canRetry: false,
    label: "Retry transcription",
    unavailable:
      row.status === "failed"
        ? "The recording is no longer stored (it expired or was deleted), so this dictation can't be recovered."
        : null,
  };
}

/** The list line under the preview, without repeating the status. */
export function rowMeta(row: DictationRow): string[] {
  return [
    row.appName,
    row.wordCount > 0
      ? `${row.wordCount.toLocaleString()} word${row.wordCount === 1 ? "" : "s"}`
      : null,
    formatSeconds(row.durationMs),
  ].filter((x): x is string => Boolean(x));
}

export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  // Round first, so 59.96 s is "1 min 00 s" and never "60.0 s" or "1 min 60 s".
  if (Math.round(s * 10) < 600) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, "0")} s`;
}

/** What the list shows as the transcript line. */
export function previewText(row: DictationRow): {
  text: string;
  muted: boolean;
} {
  const t = (row.finalText || row.rawText)?.replace(/\s+/g, " ").trim();
  if (t) return { text: t, muted: false };
  if (row.status === "failed")
    return {
      text: row.hasAudio
        ? "Transcription failed. The recording is kept so you can retry."
        : "Transcription failed.",
      muted: true,
    };
  if (row.status === "transcribing")
    return { text: "Transcribing…", muted: true };
  return { text: "No text", muted: true };
}

/** Which transcript versions exist, for the detail view's switch. */
export function transcriptVersions(row: DictationRow): {
  refined: string | null;
  raw: string | null;
  differs: boolean;
} {
  const refined = row.finalText || null;
  const raw = row.rawText || null;
  return { refined, raw, differs: Boolean(refined && raw && refined !== raw) };
}

export function cleanupLabel(row: DictationRow): string | null {
  if (!row.cleanupUsed) return null;
  if (row.cleanupUsed === "ai") return "Medium cleanup (AI)";
  if (row.cleanupNote?.startsWith("ai-fallback:"))
    return `Light cleanup (AI fell back: ${row.cleanupNote.slice(12).replace(/-/g, " ")})`;
  return row.cleanupUsed === "off" ? "No cleanup" : "Light cleanup";
}

/**
 * Why a row has no recording to play, in one plain line, from what History already knows
 * (nothing is guessed): the status, the stored error and the retention setting.
 */
export function noRecordingNote(
  row: Pick<DictationRow, "status" | "error" | "startedAt">,
  retentionDays: number,
  now: number,
): string {
  if (row.error === "secure-field") return "Not kept for password fields";
  if (row.error?.startsWith("recording kept under the previous"))
    return "Kept aside under the previous, unreadable recording key (Settings → Data and Privacy)";
  if (row.status === "inserted")
    return "Deleted once the text was inserted. Turn on Keep recordings in Settings → Data and Privacy to play future dictations";
  if (retentionDays <= 0)
    return "Recordings are deleted right away (Settings → Data and Privacy)";
  if (now - row.startedAt >= retentionDays * 86_400_000)
    return `Recording deleted after ${retentionDays} day${retentionDays === 1 ? "" : "s"} (Settings → Data and Privacy)`;
  return "Recording wasn't saved";
}
