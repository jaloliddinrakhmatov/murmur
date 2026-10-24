// Which Murmur screen is compared with which reference screenshot (`npm run compare`).
// References are private design-reference screenshots, kept out of the repository;
// only their file names live here. Routes are today's closest Murmur equivalent and will change
// as the redesign stages land.
import {
  COLUMN_PROBES,
  INSIGHTS_PROBES,
  NOTETAKER_PROBES,
  SCRATCHPAD_PROBES,
  TRANSFORMS_PROBES,
  TRANSFORM_EDITOR_PROBES,
  LANGUAGE_DIALOG_PROBES,
  MICROPHONE_DIALOG_PROBES,
  SHORTCUT_ACTION_PROBES,
  SETTINGS_GENERAL_PROBES,
  SETTINGS_PROBES,
  SHELL_PROBES,
  SHORTCUTS_DIALOG_PROBES,
  STYLE_PROBES,
  type Probe,
} from "./spec.ts";

/** A region in points of the 1350 × 850 reference window. */
export interface Region {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareTarget {
  name: string;
  /** File name inside the reference directory. */
  reference: string;
  /** Hub route to render. */
  route: string;
  regions: Region[];
  /** Measure sheet edges and colours (only meaningful without a modal overlay on either side). */
  probeShell?: boolean;
  /** DOM measurements checked against the reference (spec.ts). */
  probes?: Probe[];
  /**
   * A state without its own reference: rendered after the populated targets and compared with
   * the closest reference (documented in the Stage 4 report).
   */
  state?:
    | "empty"
    | "add-word"
    | "create-snippet"
    | "snippet-conflict"
    | "record-shortcut"
    | "scroll-end"
    | "mic-selected"
    | "mic-missing"
    | "scroll-actions"
    | "dialog-scroll-end"
    | "transform-polish"
    | "transform-prompt-engineer"
    | "transform-create";
}

export const WINDOW = { width: 1350, height: 850 } as const;

const SHELL: Region[] = [
  { name: "titlebar", x: 0, y: 0, width: 1350, height: 52 },
  { name: "sidebar", x: 0, y: 52, width: 216, height: 798 },
  { name: "content", x: 216, y: 52, width: 1134, height: 798 },
];
const MIC_DIALOG: Region = {
  name: "mic-dialog",
  x: 419,
  y: 130,
  width: 512,
  height: 590,
};
const SETTINGS: Region[] = [
  ...SHELL,
  { name: "settings-modal", x: 196, y: 106, width: 960, height: 640 },
  { name: "settings-nav", x: 196, y: 106, width: 208, height: 640 },
];
const ref = (time: string) => `Screenshot 2026-10-16 at ${time}.png`;

const DICTIONARY_REF = ref("05.57.08");
const SNIPPETS_REF = ref("05.57.29");

export const TARGETS: CompareTarget[] = [
  {
    name: "home",
    reference: ref("05.51.30"),
    route: "home",
    regions: SHELL,
    probeShell: true,
    probes: SHELL_PROBES,
  },
  {
    name: "dictionary",
    reference: ref("05.57.08"),
    route: "dictionary",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...COLUMN_PROBES],
  },
  {
    name: "snippets",
    reference: ref("05.57.29"),
    route: "snippets",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...COLUMN_PROBES],
  },
  {
    name: "notetaker",
    reference: ref("05.56.25"),
    route: "notetaker",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...NOTETAKER_PROBES],
  },
  {
    name: "insights",
    reference: ref("05.56.35"),
    route: "insights",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...INSIGHTS_PROBES],
  },
  {
    name: "scratchpad",
    reference: ref("06.00.10"),
    route: "scratchpad",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...COLUMN_PROBES, ...SCRATCHPAD_PROBES],
  },
  {
    name: "transforms",
    reference: ref("05.58.22"),
    route: "transforms",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...COLUMN_PROBES, ...TRANSFORMS_PROBES],
  },
  {
    name: "transforms-polish",
    reference: ref("05.59.25"),
    route: "transforms",
    regions: SHELL,
    state: "transform-polish",
    probes: TRANSFORM_EDITOR_PROBES,
  },
  {
    name: "transforms-prompt-engineer",
    reference: ref("05.59.37"),
    route: "transforms",
    regions: SHELL,
    state: "transform-prompt-engineer",
    probes: TRANSFORM_EDITOR_PROBES,
  },
  {
    name: "transforms-create",
    reference: ref("05.59.50"),
    route: "transforms",
    regions: SHELL,
    state: "transform-create",
    probes: TRANSFORM_EDITOR_PROBES,
  },
  {
    name: "style",
    reference: ref("05.58.00"),
    route: "style",
    regions: SHELL,
    probeShell: true,
    probes: [...SHELL_PROBES, ...COLUMN_PROBES, ...STYLE_PROBES],
  },
  {
    name: "settings-general",
    reference: ref("06.01.46"),
    route: "settings/general",
    regions: SETTINGS,
    probes: [...SETTINGS_PROBES, ...SETTINGS_GENERAL_PROBES],
  },
  {
    name: "settings-shortcuts",
    reference: ref("06.02.06"),
    route: "settings/shortcuts",
    regions: SETTINGS,
    probes: SHORTCUTS_DIALOG_PROBES,
  },
  {
    name: "settings-languages",
    reference: ref("06.03.08"),
    route: "settings/language",
    regions: SETTINGS,
    probes: LANGUAGE_DIALOG_PROBES,
  },
  {
    name: "settings-system",
    reference: ref("06.03.28"),
    route: "settings/system",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
  },
  {
    name: "settings-notetaker",
    reference: ref("06.04.12"),
    route: "settings/notetaker",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
  },
  {
    name: "settings-privacy",
    reference: ref("06.07.10"),
    route: "settings/privacy",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
  },
  // Murmur sections with no reference of their own: compared with General (same modal).
  {
    name: "settings-transcription",
    reference: ref("06.01.46"),
    route: "settings/transcription",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
  },
  {
    name: "settings-ai",
    reference: ref("06.01.46"),
    route: "settings/ai",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
  },
  {
    name: "settings-about",
    reference: ref("06.01.46"),
    route: "settings/about",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
  },
  // Microphone dialog (Stage 6B), with the Mac's real devices: system default chosen.
  {
    name: "settings-microphone",
    reference: ref("06.02.49"),
    route: "settings/microphone",
    regions: [...SETTINGS, MIC_DIALOG],
    probes: MICROPHONE_DIALOG_PROBES,
  },
  // States the references don't show, compared with the closest reference.
  {
    name: "dictionary-add-dialog",
    reference: DICTIONARY_REF,
    route: "dictionary",
    regions: SHELL,
    state: "add-word",
  },
  {
    name: "snippets-create-dialog",
    reference: SNIPPETS_REF,
    route: "snippets",
    regions: SHELL,
    state: "create-snippet",
  },
  {
    name: "snippets-conflict-dialog",
    reference: SNIPPETS_REF,
    route: "snippets",
    regions: SHELL,
    state: "snippet-conflict",
  },
  {
    name: "dictation-empty",
    reference: ref("05.51.30"),
    route: "home",
    regions: SHELL,
    probeShell: true,
    probes: SHELL_PROBES,
    state: "empty",
  },
  {
    name: "dictionary-empty",
    reference: DICTIONARY_REF,
    route: "dictionary",
    regions: SHELL,
    state: "empty",
  },
  {
    name: "snippets-empty",
    reference: SNIPPETS_REF,
    route: "snippets",
    regions: SHELL,
    state: "empty",
  },
  {
    name: "settings-shortcut-recording",
    reference: ref("06.02.06"),
    route: "settings/shortcuts",
    regions: SETTINGS,
    state: "record-shortcut",
  },
  // Stage 6B states: a specific device chosen; the chosen device unplugged (the reference shows
  // its own selected device); the optional shortcuts (reference 16, the dialog's middle).
  {
    name: "settings-microphone-selected",
    reference: ref("06.02.49"),
    route: "settings/microphone",
    regions: [...SETTINGS, MIC_DIALOG],
    probes: MICROPHONE_DIALOG_PROBES,
    state: "mic-selected",
  },
  {
    name: "settings-microphone-missing",
    reference: ref("06.02.49"),
    route: "settings/microphone",
    regions: [...SETTINGS, MIC_DIALOG],
    state: "mic-missing",
  },
  {
    name: "settings-shortcut-actions",
    reference: ref("06.02.29"),
    route: "settings/shortcuts",
    regions: SETTINGS,
    probes: SHORTCUT_ACTION_PROBES,
    state: "scroll-actions",
  },
  // Stage 8: the ends of the Shortcuts dialog (ref 17) and of Data and Privacy (ref 38).
  {
    name: "settings-shortcuts-end",
    reference: ref("06.02.37"),
    route: "settings/shortcuts",
    regions: SETTINGS,
    probes: SHORTCUTS_DIALOG_PROBES,
    state: "dialog-scroll-end",
  },
  {
    name: "settings-privacy-end",
    reference: ref("06.07.18"),
    route: "settings/privacy",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
    state: "scroll-end",
  },
  {
    name: "settings-system-data",
    reference: ref("06.03.57"),
    route: "settings/system",
    regions: SETTINGS,
    probes: SETTINGS_PROBES,
    state: "scroll-end",
  },
];
