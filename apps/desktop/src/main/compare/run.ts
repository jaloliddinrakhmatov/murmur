// Reference comparison (`npm run compare -w apps/desktop`): renders Murmur at the reference
// window size (1350 × 850 pt) against throwaway sample data, normalises each private reference
// screenshot (window cropped out of its drop shadow, transparent corners flattened, scaled to
// the same pixel size) and writes, per target: reference.png, murmur.png, side-by-side.png
// (reference left), overlay.png (Murmur at 50 % over the reference) and diff.png, plus
// summary.json / summary.md. References are read only, never modified. The output contains
// the references, so its directory is git-ignored.
import { app, nativeImage, nativeTheme, screen } from "electron";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { testKeychain } from "../settings/secure-storage.ts";
import { createApp, type MurmurApp } from "../app.ts";
import { seed } from "../capture.ts";
import {
  colorAt,
  crop,
  difference,
  firstChange,
  flatten,
  opaqueBounds,
  overlay,
  regionStats,
  resize,
  RGB,
  sideBySide,
  swapRedBlue,
  type Bitmap,
  type DiffStats,
} from "./bitmap.ts";
import { TARGETS, WINDOW, type CompareTarget } from "./targets.ts";
import { uiDriver } from "../ui-driver.ts";
import { evaluate, type Measured, type ProbeResult } from "./spec.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const execFileAsync = promisify(execFile);

/**
 * Traffic-light button frames relative to the window, read with the Accessibility API
 * (capturePage can't see native chrome). Async so the main thread can answer the AX query.
 */
async function trafficLights(
  win: Electron.BrowserWindow,
): Promise<ProbeResult[]> {
  type Frame = { x: number; y: number; width: number; height: number };
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      [
        "-l",
        "JavaScript",
        join(app.getAppPath(), "scripts/window-buttons.js"),
        String(process.pid),
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    const b = win.getBounds();
    const w = (
      JSON.parse(stdout) as Record<
        "window" | "close" | "minimize" | "zoom",
        Frame
      >[]
    ).find((x) => Math.abs(x.window.width - b.width) < 2);
    if (!w) throw new Error("window not found via AX");
    // Reference circles are centred at x 22.75 / 45.75 / 68.75, y 25.75 pt.
    return (["close", "minimize", "zoom"] as const).flatMap((k, i) => {
      const cx = w[k].x - w.window.x + w[k].width / 2;
      const cy = w[k].y - w.window.y + w[k].height / 2;
      const ex = 22.75 + 23 * i;
      return [
        {
          probe: `traffic light ${k}`,
          check: "centerX",
          expected: `${ex} ±1`,
          actual: String(cx),
          pass: Math.abs(cx - ex) <= 1,
        },
        {
          probe: `traffic light ${k}`,
          check: "centerY",
          expected: "25.75 ±1",
          actual: String(cy),
          pass: Math.abs(cy - 25.75) <= 1,
        },
      ];
    });
  } catch (e) {
    return [
      {
        probe: "traffic lights",
        check: "AX",
        expected: "measurable",
        actual: (e as Error).message.split("\n")[0],
        pass: false,
      },
    ];
  }
}
/** The reference window's canvas colour, used behind its transparent rounded corners. */
const REFERENCE_CANVAS = RGB("#f5f4f1");
const THRESHOLD = 24;

const repoRoot = () => resolve(app.getAppPath(), "..", "..");

export function compareDir(): string {
  const arg = process.argv.find((a) => a.startsWith("--compare"));
  const [, dir] = (arg ?? "").split("=");
  return dir || join(repoRoot(), "docs", "ui", "reference-comparison");
}

function toBitmap(img: Electron.NativeImage): Bitmap {
  // Re-decode the PNG so the bitmap is in device pixels, whatever the image's scale factor.
  const flat = nativeImage.createFromBuffer(img.toPNG());
  const { width, height } = flat.getSize();
  return { width, height, data: swapRedBlue(flat.toBitmap()) };
}

function writePng(file: string, bmp: Bitmap): void {
  const img = nativeImage.createFromBitmap(Buffer.from(swapRedBlue(bmp.data)), {
    width: bmp.width,
    height: bmp.height,
  });
  writeFileSync(file, img.toPNG());
}

/** The window from a macOS window screenshot (drop shadow removed), flattened. */
export function loadReference(path: string): Bitmap {
  const full = toBitmap(nativeImage.createFromPath(path));
  if (!full.width) throw new Error(`could not read ${path}`);
  const bounds = opaqueBounds(full) ?? {
    x: 0,
    y: 0,
    width: full.width,
    height: full.height,
  };
  return flatten(crop(full, bounds), REFERENCE_CANVAS);
}

/** Brings the window into a target's state (dialogs open, data removed) before capture. */
async function applyState(
  win: Electron.BrowserWindow,
  state: CompareTarget["state"],
  m: MurmurApp,
): Promise<void> {
  const d = uiDriver(win);
  const openDialog = async (label: string) => {
    await d.clickText(label);
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
  };
  if (state === "add-word") await openDialog("Add word");
  const openTransform = async (name: string) => {
    await d.waitFor(`document.querySelector('ul[aria-label="My Transforms"]')`);
    await d.js(
      `[...document.querySelectorAll('ul[aria-label="My Transforms"] button')].find((b) => b.getAttribute("aria-label")?.startsWith(${JSON.stringify(name)}))?.click()`,
    );
    await d.waitFor(`document.querySelector('[role="dialog"]')`);
  };
  if (state === "transform-polish") await openTransform("Polish");
  if (state === "transform-prompt-engineer")
    await openTransform("Prompt Engineer");
  if (state === "transform-create") await openDialog("Create New");
  if (state === "create-snippet") await openDialog("Create snippet");
  if (state === "snippet-conflict") {
    await openDialog("Create snippet");
    await d.emulateFocus(true);
    await d.js(`document.querySelector('[role="dialog"] input').focus()`);
    await d.type("my email");
    await d.waitFor(
      `document.querySelector('[role="dialog"] [aria-invalid="true"]')`,
    );
    await d.emulateFocus(false);
  }
  if (state === "scroll-end")
    await d.js(
      `document.querySelector('section[aria-labelledby="settings-section-title"] .overflow-y-auto').scrollTop = 1e6`,
    );
  // Microphone dialog states use the Mac's real devices (output stays in the git-ignored folder).
  if (state === "mic-selected" || state === "mic-missing") {
    const info = await m.microphones.list();
    const other =
      info.devices.find((x) => x.id !== info.systemDefault) ?? info.devices[0];
    if (state === "mic-selected" && other)
      await m.microphones.select({ deviceId: other.id });
    if (state === "mic-missing")
      m.settings.set("microphone", {
        deviceId: "compare-missing-device",
        name: "USB Microphone",
      });
    await d.waitFor(
      `document.querySelector('[role="radio"][aria-checked="true"]')?.dataset.micCard !== "system"`,
    );
    nativeTheme.themeSource = "light";
    await sleep(1500); // let the meter show real levels
  }
  if (state === "dialog-scroll-end")
    await d.js(
      `[...document.querySelectorAll('[role="dialog"] .overflow-y-auto')].forEach((el) => (el.scrollTop = 1e6))`,
    );
  if (state === "scroll-actions")
    await d.js(
      `document.getElementById("shortcut-copyLast").closest("section").scrollIntoView({ block: "center" })`,
    );
  if (state === "record-shortcut") {
    await d.emulateFocus(true);
    await d.click("#shortcut-recorder");
    await d.waitFor(`document.querySelector("[data-shortcut-recording]")`);
  }
  if (state) await sleep(500);
}

/** Undoes a state after it was captured and measured, so the next target starts clean. */
async function leaveState(
  win: Electron.BrowserWindow,
  state: CompareTarget["state"],
  m: MurmurApp,
): Promise<void> {
  if (state === "mic-selected" || state === "mic-missing")
    await m.microphones.select({ deviceId: null });
  // A settings change re-applies Appearance ("Auto" follows macOS, which may be dark at the
  // time of the run); comparisons are always light.
  nativeTheme.themeSource = "light";
  if (state && state !== "empty") {
    const d = uiDriver(win);
    await d.js(
      `document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click()`,
    );
    // Dialogs without a close button (the Transform editors) close with Esc.
    await sleep(150);
    if (
      await d.js<boolean>(`Boolean(document.querySelector('[role="dialog"]'))`)
    )
      await d.key("Escape");
  }
  await sleep(300);
}

/** Removes every dictation, word and snippet (the throwaway profile only) for empty states. */
function emptyData(m: MurmurApp): void {
  void m.service.clearHistory();
  for (const e of m.service.listDictionary())
    m.service.deleteDictionaryEntry({ id: e.id });
  for (const sn of m.service.listSnippets())
    m.service.deleteSnippet({ id: sn.id });
}

async function renderMurmur(
  m: MurmurApp,
  route: string,
  state?: CompareTarget["state"],
): Promise<{
  bitmap: Bitmap;
  scaleFactor: number;
  win: Electron.BrowserWindow;
}> {
  const display = screen
    .getAllDisplays()
    .reduce((a, b) => (b.scaleFactor > a.scaleFactor ? b : a));
  const win = m.hub!.show(route, { inactive: true });
  const { x, y, width, height } = display.workArea;
  win.setBounds({
    x: x + Math.max(0, Math.round((width - WINDOW.width) / 2)),
    y: y + Math.max(0, Math.round((height - WINDOW.height) / 2)),
    width: WINDOW.width,
    height: WINDOW.height,
  });
  if (win.webContents.isLoading())
    await new Promise<void>((r) =>
      win.webContents.once("did-finish-load", () => r()),
    );
  // Wait for the target itself, not a fixed time: a route sent to an open window renders
  // asynchronously (Settings opening, a dialog opening over it).
  const d = uiDriver(win);
  const ready = route.startsWith("settings")
    ? `document.getElementById("settings-section-title")` +
      (/settings\/(shortcuts|language|microphone)$/.test(route)
        ? ` && document.querySelectorAll('[role="dialog"]').length === 2`
        : ` && document.querySelectorAll('[role="dialog"]').length === 1`)
    : `!document.getElementById("settings-section-title") && document.querySelector("main#main h1")`;
  await d.waitFor(ready, 5000);
  await sleep(700);
  await applyState(win, state, m);
  const bitmap = toBitmap(await win.webContents.capturePage());
  return {
    bitmap,
    scaleFactor: display.scaleFactor,
    win,
  };
}

export interface ShellProbes {
  /** Content sheet edges in points (null when no edge was found). */
  sheetLeft: number | null;
  sheetTop: number | null;
  sheetRight: number | null;
  sheetBottom: number | null;
  canvas: string;
  sheet: string;
}

/** Measures the shell the same way in both images: walks from the canvas until the sheet. */
function probeShell(img: Bitmap, k: number): ShellProbes {
  const pt = (v: number) => Math.round(v * k);
  const toPt = (v: number | undefined) =>
    v === undefined ? null : Math.round((v / k) * 2) / 2;
  const left = firstChange(img, pt(204), pt(600), 1, 0, pt(60));
  const top = firstChange(img, pt(700), pt(30), 0, 1, pt(60));
  const right = firstChange(img, pt(1349), pt(400), -1, 0, pt(60));
  const bottom = firstChange(img, pt(700), pt(849), 0, -1, pt(60));
  return {
    sheetLeft: toPt(left?.x),
    sheetTop: toPt(top?.y),
    sheetRight: toPt(right?.x),
    sheetBottom: toPt(bottom?.y),
    canvas: colorAt(img, pt(6), pt(400)),
    sheet: colorAt(img, pt(1300), (bottom?.y ?? pt(840)) - pt(12)),
  };
}

/** Box (points, window coordinates) and computed style of the first match, or null. */
function measure(
  win: Electron.BrowserWindow,
  selector: string,
): Promise<Measured | null> {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: r.left, top: r.top, width: r.width, height: r.height,
      fontFamily: cs.fontFamily, fontSize: parseFloat(cs.fontSize),
      fontWeight: Number(cs.fontWeight), color: cs.color,
      background: cs.backgroundColor, radius: parseFloat(cs.borderTopLeftRadius) || 0,
      borderColor: cs.borderTopColor,
    };
  })()`);
}

interface TargetResult {
  name: string;
  route: string;
  reference: string;
  size: string;
  murmurScaleFactor: number;
  whole: DiffStats;
  regions: Record<string, DiffStats>;
  probes: { reference: ShellProbes; murmur: ShellProbes } | null;
  dom: ProbeResult[];
}

async function compareTarget(
  m: MurmurApp,
  t: CompareTarget,
  referenceDir: string,
  outDir: string,
): Promise<TargetResult | null> {
  const refPath = join(referenceDir, t.reference);
  if (!existsSync(refPath)) {
    console.log(`skipped ${t.name}: reference not found (${t.reference})`);
    return null;
  }
  const reference = loadReference(refPath);
  const { bitmap, scaleFactor, win } = await renderMurmur(m, t.route, t.state);
  const dom: ProbeResult[] = [];
  for (const p of t.probes ?? [])
    dom.push(...evaluate(p, await measure(win, p.selector)));
  if (t.probeShell) dom.push(...(await trafficLights(win)));
  await leaveState(win, t.state, m);
  const murmur = resize(bitmap, reference.width, reference.height);
  const dir = join(outDir, t.name);
  mkdirSync(dir, { recursive: true });
  const diff = difference(reference, murmur, THRESHOLD);
  writePng(join(dir, "reference.png"), reference);
  writePng(join(dir, "murmur.png"), murmur);
  writePng(join(dir, "side-by-side.png"), sideBySide(reference, murmur));
  writePng(join(dir, "overlay.png"), overlay(reference, murmur, 0.5));
  writePng(join(dir, "diff.png"), diff.image);
  const k = reference.width / WINDOW.width;
  const regions: Record<string, DiffStats> = {};
  for (const r of t.regions)
    regions[r.name] = regionStats(
      reference,
      murmur,
      {
        x: Math.round(r.x * k),
        y: Math.round(r.y * k),
        width: Math.round(r.width * k),
        height: Math.round(r.height * k),
      },
      THRESHOLD,
    );
  const passed = dom.filter((d) => d.pass).length;
  console.log(
    `${t.name}: ${(diff.stats.mismatch * 100).toFixed(1)} % of pixels differ` +
      (dom.length
        ? `; ${passed}/${dom.length} measurements within tolerance`
        : ""),
  );
  return {
    name: t.name,
    route: t.route,
    reference: t.reference,
    size: `${reference.width}×${reference.height}`,
    murmurScaleFactor: scaleFactor,
    whole: diff.stats,
    regions,
    probes: t.probeShell
      ? { reference: probeShell(reference, k), murmur: probeShell(murmur, k) }
      : null,
    dom,
  };
}

const pct = (s: DiffStats) => `${(s.mismatch * 100).toFixed(1)} %`;

function summaryMarkdown(results: TargetResult[]): string {
  const regionNames = [
    ...new Set(results.flatMap((r) => Object.keys(r.regions))),
  ];
  const head = `| Target | Murmur route | Whole | ${regionNames.join(" | ")} | Mean Δ |`;
  const rule = `| ${["---", "---", "---", ...regionNames.map(() => "---"), "---"].join(" | ")} |`;
  const rows = results.map(
    (r) =>
      `| ${r.name} | \`${r.route}\` | ${pct(r.whole)} | ${regionNames
        .map((n) => (r.regions[n] ? pct(r.regions[n]) : "–"))
        .join(" | ")} | ${r.whole.meanDelta.toFixed(1)} |`,
  );
  const probed = results.filter((r) => r.probes);
  const probeKeys = Object.keys(
    probed[0]?.probes?.reference ?? {},
  ) as (keyof ShellProbes)[];
  const probeRows = probed.map(
    (r) =>
      `| ${r.name} | ${probeKeys
        .map(
          (key) =>
            `${r.probes!.reference[key] ?? "–"} / ${r.probes!.murmur[key] ?? "–"}`,
        )
        .join(" | ")} |`,
  );
  return [
    "# Reference comparison summary",
    "",
    `Share of pixels whose largest channel difference exceeds ${THRESHOLD}/255 (lower is closer). Mean Δ is the mean absolute channel difference (0–255).`,
    "",
    head,
    rule,
    ...rows,
    "",
    "## Measurements against the reference (DOM probes)",
    "",
    "| Target | Probe | Check | Expected | Murmur | |",
    "| --- | --- | --- | --- | --- | --- |",
    ...results.flatMap((r) =>
      r.dom.map(
        (d) =>
          `| ${r.name} | ${d.probe} | ${d.check} | ${d.expected} | ${d.actual} | ${d.pass ? "pass" : "**off**"} |`,
      ),
    ),
    "",
    "## Shell probes (reference / Murmur; edges in pt)",
    "",
    `| Target | ${probeKeys.join(" | ")} |`,
    `| --- | ${probeKeys.map(() => "---").join(" | ")} |`,
    ...probeRows,
    "",
  ].join("\n");
}

export async function runCompare(outDir: string): Promise<number> {
  const referenceDir =
    process.env.MURMUR_REFERENCE_DIR ?? join(repoRoot(), "screenshots");
  const only = process.env.MURMUR_COMPARE?.split(",").map((s) => s.trim());
  const targets = only ? TARGETS.filter((t) => only.includes(t.name)) : TARGETS;
  if (!targets.length) {
    console.log(
      `no targets match MURMUR_COMPARE=${process.env.MURMUR_COMPARE}`,
    );
    return 1;
  }
  mkdirSync(outDir, { recursive: true });
  const m = await createApp({
    env: { shortcut: "ctrl+opt+f12" },
    keychain: testKeychain(),
  });
  seed(m);
  // The references are light; the app applies its appearance setting at start, so set it after.
  nativeTheme.themeSource = "light";
  const results: TargetResult[] = [];
  try {
    let emptied = false;
    for (const t of targets) {
      if (t.state === "empty" && !emptied) {
        emptyData(m);
        emptied = true;
        await sleep(500);
      }
      const r = await compareTarget(m, t, referenceDir, outDir);
      if (r) results.push(r);
    }
  } finally {
    m.hub?.close();
    await m.dispose();
  }
  writeFileSync(
    join(outDir, "summary.json"),
    JSON.stringify({ threshold: THRESHOLD, results }, null, 2),
  );
  writeFileSync(join(outDir, "summary.md"), summaryMarkdown(results));
  console.log(`compared ${results.length} targets → ${outDir}`);
  return results.length ? 0 : 1;
}
