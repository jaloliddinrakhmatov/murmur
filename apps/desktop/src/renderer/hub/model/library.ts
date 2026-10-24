// Pure Dictionary and Snippets screen logic (no React), unit-tested under Node
// (test/library.test.ts).
import type {
  DictionaryRow,
  SnippetIssue,
  SnippetRow,
} from "../../../shared/ipc.ts";
import { searchKey } from "../../../shared/search.ts";

/** Field limits, matching the IPC schemas and repositories. */
export const PHRASE_MIN = 2;
export const PHRASE_MAX = 60;
export const TRIGGER_MAX = 60;
export const REPLACEMENT_MAX = 4000;

export { searchKey };

function matches(query: string, fields: (string | null)[]): boolean {
  const q = searchKey(query);
  return !q || fields.some((f) => f !== null && searchKey(f).includes(q));
}

/** Matches the phrase or its "often heard as" spelling. Never changes the rows. */
export const filterDictionary = (rows: DictionaryRow[], query: string) =>
  rows.filter((r) => matches(query, [r.phrase, r.misheardAs]));

/** Matches the trigger or the replacement text. Never changes the rows. */
export const filterSnippets = (rows: SnippetRow[], query: string) =>
  rows.filter((r) => matches(query, [r.trigger, r.replacement]));

/** "6 words" / "2 of 6 words" for the list header. */
export function countLabel(
  shown: number,
  total: number,
  noun: [string, string],
): string {
  const n = (k: number) => (k === 1 ? noun[0] : noun[1]);
  return shown === total
    ? `${total} ${n(total)}`
    : `${shown} of ${total} ${n(total)}`;
}

/** One line for a list row (line breaks shown as " / "); the full text stays in the editor. */
export function oneLine(text: string, max = 160): string {
  const flat = text
    .trim()
    .replace(/\s*\n\s*/g, " / ")
    .replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export interface DictionaryForm {
  phrase: string;
  misheardAs: string;
}

/**
 * Inline validation for the add/edit dialog. `duplicate` is the existing entry with the same
 * phrase (looked up by the main process with the repository's own key), if any. Errors that only
 * mean "not filled in yet" are hidden until the field was touched, but always block saving.
 */
export function validateDictionary(
  form: DictionaryForm,
  opts: {
    editingId: string | null;
    duplicate: DictionaryRow | null;
    showRequired: boolean;
  },
): { phrase: string | null; canSave: boolean } {
  const phrase = form.phrase.trim();
  let error: string | null = null;
  let blocking = false;
  if (!phrase) {
    blocking = true;
    if (opts.showRequired) error = "Enter the word or phrase.";
  } else if (phrase.length < PHRASE_MIN) {
    blocking = true;
    if (opts.showRequired) error = `Use at least ${PHRASE_MIN} characters.`;
  } else if (opts.duplicate && opts.duplicate.id !== opts.editingId) {
    blocking = true;
    error = `“${opts.duplicate.phrase}” is already in your dictionary.`;
  }
  return { phrase: error, canSave: !blocking };
}

export interface SnippetForm {
  trigger: string;
  replacement: string;
}

const ISSUE_TEXT: Record<string, string> = {
  "empty-trigger": "Enter a trigger phrase.",
  "empty-replacement": "Enter the text to insert.",
  "duplicate-trigger": "Another snippet already uses this trigger.",
  "trigger-is-dictionary-phrase":
    "This phrase is in your dictionary, so it can't also be a trigger.",
  "trigger-too-long": `Use at most ${TRIGGER_MAX} characters.`,
  "replacement-too-long": `Use at most ${REPLACEMENT_MAX} characters.`,
  "trigger-overlaps":
    "Overlaps another trigger; when both match, the longer one wins.",
  "trigger-common-word":
    "Very short or common: it may expand when you didn't mean it to.",
  "replacement-contains-trigger":
    "The text contains its own trigger. That's allowed; it never expands twice.",
};

const REQUIRED = new Set(["empty-trigger", "empty-replacement"]);
const REPLACEMENT_CODES = new Set([
  "empty-replacement",
  "replacement-too-long",
]);

export function issueText(issue: SnippetIssue): string {
  const text = ISSUE_TEXT[issue.code] ?? issue.code;
  return "detail" in issue && issue.detail
    ? `${text} (“${issue.detail}”)`
    : text;
}

/**
 * Splits the main process's conflict check into field errors and warnings. Errors block saving;
 * "required" errors are only shown once the field was touched. Warnings never block.
 */
export function validateSnippet(
  form: SnippetForm,
  issues: SnippetIssue[],
  opts: { showTriggerRequired: boolean; showReplacementRequired: boolean },
): {
  trigger: string | null;
  replacement: string | null;
  warnings: string[];
  canSave: boolean;
} {
  let trigger: string | null = null;
  let replacement: string | null = null;
  const missing = !form.trigger.trim() || !form.replacement.trim();
  for (const issue of issues) {
    if (issue.level !== "error") continue;
    const isReplacement = REPLACEMENT_CODES.has(issue.code);
    const show = !REQUIRED.has(issue.code)
      ? true
      : isReplacement
        ? opts.showReplacementRequired
        : opts.showTriggerRequired;
    if (!show) continue;
    if (isReplacement) replacement ??= issueText(issue);
    else trigger ??= issueText(issue);
  }
  return {
    trigger,
    replacement,
    warnings: issues
      .filter((i) => i.level === "warning")
      .map((i) => issueText(i)),
    canSave: !missing && !issues.some((i) => i.level === "error"),
  };
}

/** Orders the stored data supports: when an item was added, its text, and real usage counts. */
export const SORT_ORDERS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "az", label: "A to Z" },
  { id: "used", label: "Most used" },
] as const;
export type SortOrder = (typeof SORT_ORDERS)[number]["id"];

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/**
 * A sorted copy (the input is never changed). Every order ends with the id, so equal items
 * always come out in the same order.
 */
export function sortLibrary<
  T extends { id: string; createdAt: number; usageCount: number },
>(rows: T[], order: SortOrder, text: (row: T) => string): T[] {
  const byText = (a: T, b: T) => collator.compare(text(a), text(b));
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const compare: Record<SortOrder, (a: T, b: T) => number> = {
    newest: (a, b) => b.createdAt - a.createdAt || byId(a, b),
    oldest: (a, b) => a.createdAt - b.createdAt || byId(a, b),
    az: (a, b) => byText(a, b) || byId(a, b),
    used: (a, b) => b.usageCount - a.usageCount || byText(a, b) || byId(a, b),
  };
  return [...rows].sort(compare[order]);
}
