// Typed access to the Rust addon (@murmur/native). Loaded lazily so unit tests and smoke runs can
// substitute fakes.
import { createRequire } from "node:module";

export interface NativeAddon {
  nowMs(): number;
  permissionStatus(): {
    accessibility: boolean;
    inputMonitoring: boolean;
    postEvents: boolean;
    secureEventInput: boolean;
  };
  requestAccessibility(): boolean;
  validateShortcut(
    shortcut: string,
    action: string,
  ): {
    normalized: string;
    backend: string;
    errors: string[];
    warnings: string[];
  };
  findShortcutConflicts(
    shortcuts: string[],
  ): { a: number; b: number; kind: string }[];
  registerHotkey(
    id: number,
    shortcut: string,
    options:
      | { exclusive?: boolean; action?: string; skipValidation?: boolean }
      | undefined,
    callback: (event: {
      id: number;
      kind: "pressed" | "released";
      tMs: number;
    }) => void,
  ): { ok: boolean; status: number; error?: string; normalized?: string };
  unregisterHotkey(id: number): number;
  registeredHotkeyCount?(): number;
  frontmostApp(): { pid: number; name?: string; bundleId?: string } | null;
  focusedElement(): {
    ok: boolean;
    error?: string;
    role?: string;
    subrole?: string;
    isSecure: boolean;
  };
  /** Stage 9C: only the focused element's selected text and range (never its whole value). */
  readSelection(): {
    ok: boolean;
    error?: string;
    pid?: number;
    role?: string;
    subrole?: string;
    isSecure: boolean;
    text?: string;
    rangeLocation?: number;
    rangeLength?: number;
    editable: boolean;
    elementKey?: string;
  };
  insertText(
    text: string,
    options?: {
      allowAccessibility?: boolean;
      allowPaste?: boolean;
      modifierWaitMs?: number;
    },
  ): {
    strategy:
      "accessibility" | "clipboard-paste" | "clipboard-only" | "rejected";
    ok: boolean;
    verified: boolean;
    reason?: string;
    snapshotId?: number;
    changeCountAfterWrite?: number;
    elapsedMs: number;
    steps: string[];
  };
  clipboardRestore(
    snapshotId: number,
    expectedChangeCount: number,
  ): { restored: boolean; reason: string };
  clipboardWriteText(text: string, transient?: boolean): number;
  clipboardReadText(): string | null;
  clipboardChangeCount(): number;
  /**
   * Stage E: presses Return in the app in front, after the shortcut's modifiers are released.
   * Refuses ("target-changed") unless that app is `expectedPid`, and ("secure-input") while macOS
   * secure event input is on.
   */
  pressReturn(
    modifierWaitMs: number | undefined,
    expectedPid: number,
  ): {
    ok: boolean;
    reason?: string;
    steps: string[];
  };
  /**
   * Copies the selection of the frontmost app (⌘C) for apps that don't share it through
   * Accessibility, then restores the clipboard. Refuses ("target-changed") unless that app is
   * `expectedPid`, ("secure-input" / "secure-text-field") for password input, and never reads a
   * concealed copy. Other reasons: "nothing-copied", "too-long", "sensitive", "modifiers-still-held",
   * "no-post-event-permission", "event-failed".
   */
  copySelection(
    expectedPid: number,
    modifierWaitMs: number | undefined,
    timeoutMs: number | undefined,
  ): { ok: boolean; text?: string; reason?: string };
  /** Stage E part 2: a bounded window of the focused field's text (never a password field). */
  readTextAround(
    location: number | null,
    before: number,
    after: number,
  ): {
    ok: boolean;
    error?: string;
    pid?: number;
    isSecure: boolean;
    text?: string;
    start?: number;
    cursor?: number;
    elementKey?: string;
  };
  /**
   * Vibe coding: the title of the window holding the focused field (null for a password field).
   * Absent in addons built before it was added.
   */
  focusedWindowTitle?(): string | null;
  /** Stage E: whether the Mac's sound output is muted (null: the device has no mute). */
  outputMuted(): boolean | null;
  setOutputMuted(muted: boolean): boolean;
  /** Stage 9D-2: "available", "unsupported-os" or "missing-usage-description" (asks nothing). */
  systemAudioSupport(): string;
  /** Connectors → Calendar (EventKit). Status and support ask nothing; see shared/calendar.ts. */
  calendarAccess(): string;
  calendarSupport(): string;
  /** Shows macOS's prompt: call only from the person's click. */
  requestCalendarAccess(): Promise<string>;
  listUpcomingEvents(
    fromMs: number,
    toMs: number,
    max: number,
  ): Promise<NativeCalendarEvent[]>;
  listCalendars(): Promise<NativeCalendarInfo[]>;
  /** What this Mac plays (a Core Audio process tap), as 16 kHz mono PCM16. */
  SystemAudioTap: new () => {
    /** Resolves once the tap runs (it can wait on macOS's permission prompt; never blocks). */
    start(): Promise<void>;
    read(): Buffer;
    stop(): void;
    readonly running: boolean;
  };
  HoldToTalk: new (config?: {
    minHoldMs?: number;
    doubleTapMs?: number;
    warnAtMs?: number;
    maxSessionMs?: number;
  }) => {
    handle(
      kind: "down" | "up" | "other" | "cancel" | "tick",
      tMs: number,
    ): string[];
    readonly state: string;
  };
}

let cached: NativeAddon | null = null;

export function loadNative(): NativeAddon {
  if (!cached) {
    const require = createRequire(import.meta.url);
    cached = require("@murmur/native") as NativeAddon;
  }
  return cached;
}

export interface NativeCalendarEvent {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  calendar: string;
  account: string;
  /** EventKit source type: 0 local, 1 Exchange, 2 CalDAV, 3 iCloud, 4 subscribed, 5 birthdays. */
  sourceType: number;
  location?: string | null;
  url?: string | null;
  notes?: string | null;
}

export interface NativeCalendarInfo {
  title: string;
  account: string;
  sourceType: number;
}
