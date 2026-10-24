// The sidebar "Set up Murmur" checklist (pure; unit-tested in test/home.test.ts). Every step is
// a real readiness check from the main process; the card shows until all of them pass and
// comes back as soon as one stops passing. Only what dictation needs is a step: Accessibility
// (automatic pasting) is optional, because without it each dictation is copied instead.
import type { StatusInfo } from "../../../shared/ipc.ts";
import type { SettingsTarget } from "./settings-sections.ts";

export interface SetupStep {
  key: "microphone" | "shortcut" | "transcription";
  label: string;
  done: boolean;
  /** Where the step is completed. */
  section: SettingsTarget;
}

export interface SetupChecklist {
  steps: SetupStep[];
  done: number;
  complete: boolean;
  /** The first unfinished step's Settings section (the card's own destination). */
  next: SettingsTarget | null;
}

/** Microphone, shortcut and transcription: what shortcut-based dictation needs. */
export function setupChecklist(status: StatusInfo): SetupChecklist {
  const steps: SetupStep[] = [
    {
      key: "microphone",
      label: "Microphone access",
      done: status.permissions.microphone === "granted",
      section: "microphone",
    },
    {
      key: "shortcut",
      label: "Dictation shortcut",
      done: status.shortcut.registered,
      section: "shortcuts",
    },
    {
      key: "transcription",
      label: "Transcription service",
      done: status.providerReady === null,
      section: "transcription",
    },
  ];
  const done = steps.filter((s) => s.done).length;
  return {
    steps,
    done,
    complete: done === steps.length,
    next: steps.find((s) => !s.done)?.section ?? null,
  };
}
