// Smoke checks for the Capsule: what each controller state looks like in the real overlay, the
// waveform driven by level events, the shortcut notice and placement on every display.
// Runs inside `npm run smoke` (microphone lifecycle checks are in smoke-audio.ts).
import { screen } from "electron";
import type { MurmurApp } from "./app.ts";
import type { CapsuleState } from "../shared/ipc.ts";

type Check = (name: string, ok: boolean, details?: unknown) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runCapsuleChecks(
  m: MurmurApp,
  check: Check,
): Promise<void> {
  const c = m.capsule;
  const js = <T>(code: string) =>
    c.win.webContents.executeJavaScript(code) as Promise<T>;
  const look = () =>
    js<{
      state: string;
      tone: string;
      wave: boolean;
      text: string;
      spoken: string;
      bars: number[];
      cancel: boolean;
      live: string;
    }>(`(() => {
      const el = document.getElementById("capsule");
      return {
        state: el.dataset.state,
        tone: el.dataset.tone,
        wave: getComputedStyle(el.querySelector(".wave")).display !== "none",
        text: el.querySelector(".label").textContent,
        spoken: el.querySelector(".sr").textContent,
        bars: [...el.querySelectorAll(".wave i")].map((b) => parseInt(b.style.height)),
        cancel: getComputedStyle(el.querySelector(".cancel")).display !== "none",
        live: el.dataset.live,
      };
    })()`);

  // Every state the controller emits renders with its own words.
  const seen: Record<string, string> = {};
  for (const s of [
    "listening",
    "handsFree",
    "processing",
    "refining",
    "inserting",
    "inserted",
    "copied",
    "cancelled",
    "error",
    "warning",
  ] as CapsuleState[]) {
    await c.showAndAwaitPaint(s);
    const l = await look();
    seen[s] = `${l.state}|${l.tone}|${l.spoken}`;
  }
  const spokenTexts = Object.values(seen).map((v) => v.split("|")[2]);
  check(
    "capsule: every controller state renders, each with its own announcement",
    Object.entries(seen).every(([s, v]) => v.startsWith(`${s}|`)) &&
      new Set(spokenTexts).size === spokenTexts.length,
    seen,
  );

  // Waveform: until the microphone delivers audio the Capsule says it is starting and shows no
  // waveform (Stage 8); real level events then show the recording waveform; it resets when
  // recording ends.
  await c.showAndAwaitPaint("listening");
  const flat = await look();
  for (const rms of [0.01, 0.05, 0.2]) c.level(rms);
  await sleep(150);
  const moving = await look();
  await c.showAndAwaitPaint("processing");
  const after = await look();
  check(
    "capsule: “Starting mic…” (no waveform) until the microphone delivers audio, then the waveform rises with real levels, resets after recording",
    !flat.wave &&
      flat.spoken === "Microphone starting" &&
      flat.bars.every((h) => h === 3) &&
      flat.live === "false" &&
      moving.wave &&
      moving.spoken === "Recording" &&
      moving.live === "true" &&
      after.live === "false" &&
      moving.bars.at(-1)! > moving.bars.at(-3)! &&
      moving.bars.at(-3)! > 3 &&
      !after.wave,
    { flat: flat.bars, moving: moving.bars, live: [flat.live, moving.live] },
  );
  c.level(0.3);
  await sleep(100);
  const ignored = await look();
  check(
    "capsule waveform: level events outside recording are ignored",
    ignored.bars.every((h) => h === 3),
  );

  // Inserted vs copied, and the controller's reason text.
  await c.showAndAwaitPaint("inserted");
  const inserted = await look();
  await c.showAndAwaitPaint("copied", "App changed — copied, press ⌘V");
  const copied = await look();
  check(
    "capsule: inserted and copied differ in words and colour; the reason is shown once",
    inserted.text === "Inserted" &&
      inserted.tone === "success" &&
      copied.tone === "warning" &&
      copied.text === "App changed — copied, press ⌘V" &&
      copied.spoken === copied.text,
  );

  // Standing notice at rest (e.g. the shortcut couldn't be registered).
  c.setNotice("Shortcut unavailable — open Settings");
  await c.showAndAwaitPaint("resting");
  const notice = await look();
  c.setNotice(null);
  await sleep(100);
  const plain = await look();
  check(
    "capsule: a shortcut notice shows at rest and clears",
    notice.text === "Shortcut unavailable — open Settings" &&
      notice.tone === "warning" &&
      plain.text === "",
  );

  // Placement: inside the work area (clear of the menu bar and Dock) of every display.
  const displays = screen.getAllDisplays();
  const { capsuleBoundsFor } = await import("./windows/capsule.ts");
  const placements = displays.map((d) => {
    const b = capsuleBoundsFor(d);
    const wa = d.workArea;
    return (
      b.x >= wa.x &&
      b.y >= wa.y &&
      b.x + b.width <= wa.x + wa.width &&
      b.y + b.height <= wa.y + wa.height
    );
  });
  check(
    `capsule placement: inside the work area on all ${displays.length} display(s)`,
    placements.every(Boolean),
    displays.map((d) => d.workArea),
  );
  check(
    "capsule window: still non-focusable and click-through after the redesign",
    !c.win.isFocusable() && c.win.isAlwaysOnTop(),
  );
}
