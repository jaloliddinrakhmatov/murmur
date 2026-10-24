// A dictation still "transcribing" when Murmur starts was cut off by a quit or crash: nothing is
// working on it any more. It becomes a failed row that keeps its recording, so Retry works.
import type { DictationRecord } from "../core/types.ts";

export interface InterruptedHistory {
  list(query: { status: DictationRecord["status"]; limit: number }): {
    id: string;
  }[];
  update(id: string, patch: Partial<DictationRecord>): void;
}

export const INTERRUPTED_ERROR = "Murmur quit before this finished";

/** Call once at launch, before any dictation can start. Returns how many rows were fixed. */
export function recoverInterruptedDictations(
  history: InterruptedHistory,
): number {
  const rows = history.list({ status: "transcribing", limit: 10_000 });
  for (const row of rows)
    history.update(row.id, { status: "failed", error: INTERRUPTED_ERROR });
  return rows.length;
}
