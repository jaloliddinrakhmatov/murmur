// Measured reference values checked against the live Murmur window (`npm run compare`): each
// probe selects one element, reads its box (points, window coordinates) and computed style, and
// compares with the reference within a tolerance.
// Pure: the evaluation is unit-tested in test/compare.test.ts.

export interface Measured {
  left: number;
  top: number;
  width: number;
  height: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  background: string;
  radius: number;
  borderColor: string;
}

type NumericKey =
  "left" | "top" | "width" | "height" | "fontSize" | "fontWeight" | "radius";
type TextKey = "fontFamily" | "color" | "background" | "borderColor";

export interface Probe {
  name: string;
  selector: string;
  /** [expected, tolerance] in points (or weight units). */
  numbers?: Partial<Record<NumericKey, [number, number]>>;
  /** Expected values; colours as #rrggbb, fontFamily matched on the first family name. */
  text?: Partial<Record<TextKey, string>>;
  /** Centre position checks: [expected, tolerance]. */
  centerX?: [number, number];
  centerY?: [number, number];
}

export interface ProbeResult {
  probe: string;
  check: string;
  expected: string;
  actual: string;
  pass: boolean;
}

/** `rgb(…)`/`rgba(…)` → `#rrggbb` (alpha ignored; transparent becomes "transparent"). */
export function toHex(css: string): string {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return css;
  const [r, g, b, a] = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (a === 0) return "transparent";
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

const firstFamily = (f: string) =>
  f
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");

export function evaluate(probe: Probe, m: Measured | null): ProbeResult[] {
  if (!m)
    return [
      {
        probe: probe.name,
        check: "present",
        expected: probe.selector,
        actual: "not found",
        pass: false,
      },
    ];
  const out: ProbeResult[] = [];
  const num = (check: string, actual: number, [exp, tol]: [number, number]) =>
    out.push({
      probe: probe.name,
      check,
      expected: `${exp} ±${tol}`,
      actual: String(Math.round(actual * 10) / 10),
      pass: Math.abs(actual - exp) <= tol,
    });
  for (const [k, v] of Object.entries(probe.numbers ?? {}))
    num(k, m[k as NumericKey], v as [number, number]);
  if (probe.centerX) num("centerX", m.left + m.width / 2, probe.centerX);
  if (probe.centerY) num("centerY", m.top + m.height / 2, probe.centerY);
  for (const [k, v] of Object.entries(probe.text ?? {})) {
    const actual =
      k === "fontFamily" ? firstFamily(m.fontFamily) : toHex(m[k as TextKey]);
    out.push({
      probe: probe.name,
      check: k,
      expected: v as string,
      actual,
      pass: actual.toLowerCase() === (v as string).toLowerCase(),
    });
  }
  return out;
}

const NAV = 'nav[aria-label="Main"]';

/** Shell probes valid on every page without a modal (reference 01, 05–08, 12). */
export const SHELL_PROBES: Probe[] = [
  {
    name: "window canvas",
    selector: "body",
    text: { background: "#f5f4f1", fontFamily: "Figtree" },
  },
  {
    name: "content sheet",
    selector: "main#main",
    numbers: {
      left: [216, 1],
      top: [52, 1],
      width: [1126, 1],
      height: [790, 1],
      radius: [24, 2],
    },
    text: { background: "#fcfcfb", borderColor: "#eeebe4" },
  },
  {
    name: "sidebar",
    selector: NAV,
    numbers: { left: [0, 0], width: [216, 1] },
  },
  {
    name: "first nav item",
    selector: `${NAV} > div:nth-of-type(2) > :first-child`,
    numbers: {
      left: [12, 1],
      top: [123, 2],
      width: [192, 1],
      height: [36, 1],
      radius: [8, 1],
      fontSize: [15, 0],
    },
    text: { fontFamily: "Figtree", color: "#1a1a1a" },
  },
  {
    name: "second nav item (pitch)",
    selector: `${NAV} > div:nth-of-type(2) > :nth-child(2)`,
    numbers: { top: [163, 2], height: [36, 1] },
  },
  {
    name: "nav icon",
    selector: `${NAV} > div:nth-of-type(2) > :first-child span:first-child`,
    numbers: { left: [19, 2], width: [18, 1] },
  },
  {
    name: "nav label",
    selector: `${NAV} > div:nth-of-type(2) > :first-child span:nth-child(2)`,
    numbers: { left: [49, 2] },
  },
  {
    name: "selected nav item",
    selector: `${NAV} [aria-current="page"]`,
    text: { background: "#eeebe4" },
  },
  {
    name: "sidebar toggle",
    selector: "header button",
    centerX: [108, 2],
    centerY: [26, 2],
  },
  {
    name: "page title",
    selector: "main#main h1",
    // Figtree 24/32: the ink top sits 7 pt below the line box (measured), so the reference's
    // ink top at y 100 pt means a box top of 93 pt.
    numbers: { top: [93, 1], fontSize: [24, 0], fontWeight: [600, 0] },
    text: { fontFamily: "Figtree", color: "#1a1a1a" },
  },
];

/** Pages laid out in the reference's centred 800 pt column (Dictionary, Snippets, Style). */
export const COLUMN_PROBES: Probe[] = [
  {
    name: "page title column",
    selector: "main#main h1",
    numbers: { left: [379, 2] },
  },
];

/** Style page (reference 07): level cards. */
export const STYLE_PROBES: Probe[] = [
  {
    name: "style cards",
    selector: '[role="radiogroup"][aria-label="Cleanup level"] > :first-child',
    numbers: { width: [256, 3], height: [360, 6], radius: [14, 2] },
  },
  {
    name: "selected style card title",
    selector:
      '[role="radiogroup"][aria-label="Cleanup level"] [aria-checked="true"] > span:first-child',
    text: { fontFamily: "EB Garamond" },
  },
];

/** Insights (reference 05.56.35): a 4-column grid; first row 242 + 242 + 509 pt, at y 242. */
export const INSIGHTS_PROBES: Probe[] = [
  {
    name: "insights speed card",
    selector: 'main#main section[aria-label="Speed"]',
    numbers: { width: [242, 6], top: [242, 8] },
  },
  {
    name: "insights words card",
    selector: 'main#main section[aria-label="Words"]',
    numbers: { width: [509, 6], top: [242, 8] },
  },
  {
    name: "insights streak card",
    selector: 'main#main section[aria-label="Streak"]',
    numbers: { width: [509, 6] },
  },
];

/** Scratchpad (reference 12): 799 × 226 pt banner at y 153, grey 189 × 34 pt shortcut capsule. */
export const SCRATCHPAD_PROBES: Probe[] = [
  {
    name: "scratchpad banner",
    selector: 'main#main section[data-banner="scratchpad"]',
    numbers: { width: [799, 4], height: [226, 6], top: [153, 4] },
  },
  {
    name: "scratchpad shortcut capsule",
    selector: "main#main div:has(> #shortcut-openScratchpad)",
    numbers: { width: [189, 6], height: [34, 2] },
  },
  {
    name: "start new note button",
    selector: 'main#main section[data-banner="scratchpad"] button',
    numbers: { height: [35, 3] },
  },
];

/**
 * Notetaker (reference 02, 05.56.25): a 761 pt main column 41 pt inside the sheet and a right
 * column from x 1059; Today card at y 150 with the 721 × 79 pt tour card at y 194; Past notes
 * underline at y 429; the 61 pt empty-state card at y 454; the 31 pt peach button at y 94.
 */
export const NOTETAKER_PROBES: Probe[] = [
  {
    name: "notetaker title",
    selector: "main#main h1",
    numbers: { left: [258, 3] },
  },
  {
    name: "notetaker main action",
    selector: 'main#main button[data-variant="soft"]',
    numbers: { height: [31, 3], top: [94, 5] },
  },
  {
    name: "today card",
    selector: 'main#main section[aria-labelledby="today-title"]',
    numbers: { width: [761, 6], top: [150, 6] },
  },
  {
    name: "set up notetaker card",
    selector: "main#main [data-notetaker-tour]",
    numbers: { width: [721, 6], height: [79, 5], top: [194, 6] },
  },
  {
    name: "meetings empty state",
    selector: "main#main [data-meetings-empty]",
    numbers: { width: [761, 6], height: [61, 4], top: [454, 8] },
  },
  {
    name: "notetaker right column",
    selector: 'main#main aside[aria-label="Notetaker status"]',
    numbers: { left: [1059, 6] },
  },
];

/** Transforms (reference 08): 799 × 199 pt banner at y 153; cards 255 × 162 pt, 18 pt apart. */
export const TRANSFORMS_PROBES: Probe[] = [
  {
    name: "transforms banner",
    selector: 'main#main section[data-banner="transforms"]',
    numbers: { width: [799, 4], height: [199, 6], top: [153, 4] },
  },
  {
    name: "transform card",
    selector:
      'main#main ul[aria-label="My Transforms"] > li:first-child > button',
    numbers: { width: [255, 6], height: [162, 6] },
  },
];

/** Transform editors (references 09–11): 960 × 655 pt, left column 320 pt. */
export const TRANSFORM_EDITOR_PROBES: Probe[] = [
  {
    name: "transform editor",
    selector:
      'div[role="dialog"]:has(#transform-shortcut-polish, #transform-shortcut-prompt-engineer, #transform-name)',
    numbers: { width: [960, 4], height: [655, 6] },
  },
  {
    name: "transform editor left column",
    selector: 'div[role="dialog"] > div:first-child',
    numbers: { width: [320, 4] },
  },
];

const SHEET = 'div[role="dialog"]:has(nav[aria-label="Settings sections"])';
const SETTINGS_NAV = 'nav[aria-label="Settings sections"]';

/** Settings modal (reference 14–38): 960 × 640 centred, 208 pt nav, white content. */
export const SETTINGS_PROBES: Probe[] = [
  {
    name: "settings modal",
    selector: SHEET,
    numbers: {
      left: [195, 1],
      top: [105, 1],
      width: [960, 1],
      height: [640, 1],
      radius: [12, 2],
    },
    text: { background: "#ffffff" },
  },
  {
    name: "settings nav",
    selector: SETTINGS_NAV,
    numbers: { width: [208, 1] },
    text: { background: "#f5f4f1" },
  },
  {
    name: "settings first nav item",
    selector: `${SETTINGS_NAV} button`,
    numbers: {
      left: [204, 1],
      top: [155.5, 2],
      width: [192, 1],
      height: [36, 1],
      fontSize: [15, 0],
    },
  },
  {
    name: "settings second nav item (pitch)",
    selector: `${SETTINGS_NAV} button:nth-of-type(2)`,
    numbers: { top: [191.5, 2] },
  },
  {
    name: "settings section title",
    selector: "#settings-section-title",
    numbers: { left: [453, 2], top: [149, 2], fontSize: [28, 0] },
    text: { fontFamily: "EB Garamond", color: "#1a1a1a" },
  },
];

/** General (reference 14): the first card and its “Change” buttons. */
export const SETTINGS_GENERAL_PROBES: Probe[] = [
  {
    name: "general card",
    selector: 'section[aria-labelledby="settings-section-title"] .rounded-card',
    numbers: {
      left: [453, 2],
      top: [218, 2],
      width: [655, 3],
      radius: [14, 2],
    },
    text: { background: "#f5f4f1" },
  },
  {
    name: "Change button",
    selector: "#shortcuts-change",
    numbers: {
      left: [924, 2],
      width: [164, 1],
      height: [36, 1],
      radius: [8, 1],
    },
    text: { background: "#eeebe4" },
  },
];

const DIALOG_OVER = `[role="dialog"]:not(:has(nav[aria-label="Settings sections"]))`;

/** Shortcuts dialog (reference 15): 664 × 588 pt. */
export const SHORTCUTS_DIALOG_PROBES: Probe[] = [
  {
    name: "shortcuts dialog",
    selector: DIALOG_OVER,
    numbers: {
      left: [343, 2],
      top: [131, 2],
      width: [664, 1],
      height: [588, 2],
    },
    text: { background: "#fcfcfb" },
  },
  {
    name: "shortcut field",
    selector: "#shortcut-recorder",
    numbers: { width: [215, 1], height: [43, 1], radius: [8, 1] },
  },
];

/**
 * Microphone dialog (reference 18, measured from the screenshot at 2 px/pt): 512 × 590 pt at
 * (419, 130); the chosen device's card 464 × 90 pt at (443, 250), 8 pt corners; a 17.5 ×
 * 53.5 pt meter of seven bars; a 32 pt footer button.
 */
export const MICROPHONE_DIALOG_PROBES: Probe[] = [
  {
    name: "microphone dialog",
    selector: DIALOG_OVER,
    numbers: {
      left: [419, 2],
      top: [130, 2],
      width: [512, 1],
      height: [590, 2],
    },
    text: { background: "#fcfcfb" },
  },
  {
    name: "chosen microphone card",
    selector: '[data-mic-card][aria-checked="true"]',
    numbers: {
      left: [443, 1],
      top: [250, 3],
      width: [464, 1],
      height: [90, 3],
      radius: [8, 1],
    },
  },
  {
    name: "level meter",
    selector: '[role="meter"]',
    numbers: { width: [17.5, 1], height: [53.5, 1] },
  },
  {
    name: "footer button",
    selector: `${DIALOG_OVER} button.h-8`,
    numbers: { height: [31.5, 1] },
  },
];

/** The optional shortcuts' fields (reference 16): 215 × 43 pt, like push to talk's. */
export const SHORTCUT_ACTION_PROBES: Probe[] = [
  {
    name: "action shortcut field",
    selector: "div:has(> #shortcut-pasteLast)",
    numbers: { width: [215, 2], height: [43, 1], radius: [8, 1] },
  },
];

/** Language dialog (reference 19): 852 × 570 pt. */
export const LANGUAGE_DIALOG_PROBES: Probe[] = [
  {
    name: "language dialog",
    selector: DIALOG_OVER,
    numbers: {
      left: [249, 2],
      top: [140, 2],
      width: [852, 1],
      height: [570, 2],
    },
    text: { background: "#ffffff" },
  },
  {
    name: "language tile",
    selector: '[aria-label="Language"] [role="radio"]',
    numbers: { height: [54, 2], radius: [8, 1] },
  },
];
