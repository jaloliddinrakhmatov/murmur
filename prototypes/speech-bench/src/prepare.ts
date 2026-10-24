// Builds the benchmark sample sets in prototypes/.cache/samples from the FLEURS clips fetched by
// scripts/setup-local-providers.sh plus macOS TTS for technical vocabulary.
//
// Sets (all 16 kHz mono PCM16):
//   en-short, uz-short     real read speech (FLEURS), one sentence each
//   en-long, uz-long       6 real clips concatenated with 0.6 s pauses (≈60–90 s dictation)
//   en-babble-5db, uz-babble-5db   real clips + babble made from 3 other real clips at 5 dB SNR
//   en-white-10db, uz-white-10db   real clips + white noise at 10 dB SNR
//   mixed-uz-en            an Uzbek clip followed by an English clip (between-sentence switch,
//                          a proxy only: no real code-switched recordings were available)
//   tech-en-tts            SYNTHETIC: macOS "Samantha" voice reading developer vocabulary
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../../lib/stats.ts";
import { concat, mixAtSnr, readWav, writeWav } from "./wav.ts";
import type { Sample } from "./samples.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FLEURS = join(ROOT, ".cache/datasets/fleurs");
const OUT = join(ROOT, ".cache/samples");
const RATE = 16000;

const TECH: { text: string; terms: string[] }[] = [
  {
    text: "Refactor the useEffect hook in UserProfile.tsx so it calls fetchUserById with the user ID from the route.",
    terms: ["useEffect", "UserProfile.tsx", "fetchUserById"],
  },
  {
    text: "Run kubectl get pods in the staging namespace and check whether the nginx ingress restarted.",
    terms: ["kubectl", "nginx"],
  },
  {
    text: "The PostgreSQL migration adds a non-null column called created_at with a default of now.",
    terms: ["PostgreSQL", "created_at"],
  },
  {
    text: "Open a pull request against main and add Dilnoza and Jaloliddin as reviewers.",
    terms: ["Dilnoza", "Jaloliddin"],
  },
  {
    text: "Set the OAuth redirect URI to the local callback route before testing sign in.",
    terms: ["OAuth"],
  },
  {
    text: "Our p95 latency regressed from 850 milliseconds to 1.4 seconds after the Prisma upgrade.",
    terms: ["Prisma"],
  },
  {
    text: "Use napi-rs to expose the CGEventTap callback to Electron through a threadsafe function.",
    terms: ["napi-rs", "CGEventTap", "Electron"],
  },
  {
    text: "Install Tailwind and shadcn/ui, then add the dialog and dropdown menu components.",
    terms: ["Tailwind", "shadcn/ui"],
  },
  {
    text: "The NestJS guard should return 401 when the JWT is expired and 403 when the role is missing.",
    terms: ["NestJS", "JWT"],
  },
  {
    text: "Summarize the Grafana dashboard for the Redis cache hit ratio.",
    terms: ["Grafana", "Redis"],
  },
];

function toPcm16(input: string, output: string) {
  execFileSync("afconvert", [
    "-f",
    "WAVE",
    "-d",
    `LEI16@${RATE}`,
    "-c",
    "1",
    input,
    output,
  ]);
}

function loadFleurs(
  lang: string,
): { id: string; path: string; reference: string }[] {
  const dir = join(FLEURS, lang);
  const manifest = readFileSync(join(dir, "manifest.tsv"), "utf8")
    .trim()
    .split("\n");
  return manifest.map((line) => {
    const [file, reference] = line.split("\t");
    return { id: file.replace(/\.wav$/, ""), path: join(dir, file), reference };
  });
}

function save(
  set: string,
  id: string,
  samples: Float32Array,
): { path: string; durationSec: number } {
  mkdirSync(join(OUT, set), { recursive: true });
  const path = join(OUT, set, `${id}.wav`);
  writeFileSync(path, writeWav({ sampleRate: RATE, samples }));
  return { path, durationSec: +(samples.length / RATE).toFixed(2) };
}

function main() {
  if (!existsSync(FLEURS))
    throw new Error(
      "FLEURS clips missing: run prototypes/scripts/setup-local-providers.sh",
    );
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "_pcm"), { recursive: true });
  const out: Sample[] = [];
  const pcm: Record<
    string,
    { id: string; reference: string; audio: Float32Array }[]
  > = {};

  for (const [lang, code] of [
    ["en_us", "en"],
    ["uz_uz", "uz"],
  ] as const) {
    pcm[code] = loadFleurs(lang).map((clip) => {
      const converted = join(OUT, "_pcm", `${code}-${clip.id}.wav`);
      toPcm16(clip.path, converted);
      return {
        id: clip.id,
        reference: clip.reference,
        audio: readWav(readFileSync(converted)).samples,
      };
    });
    const clips = pcm[code];

    for (const c of clips)
      out.push({
        id: c.id,
        set: `${code}-short`,
        language: code,
        reference: c.reference,
        synthetic: false,
        ...save(`${code}-short`, c.id, c.audio),
      });

    for (const [i, group] of [
      clips.slice(0, 6),
      clips.slice(6, 12),
    ].entries()) {
      const audio = concat(
        group.map((c) => c.audio),
        Math.round(0.6 * RATE),
      );
      out.push({
        id: `long-${i}`,
        set: `${code}-long`,
        language: code,
        reference: group.map((c) => c.reference).join(" "),
        synthetic: false,
        ...save(`${code}-long`, `long-${i}`, audio),
      });
    }

    const rng = mulberry32(code === "en" ? 7 : 11);
    for (const [i, c] of clips.entries()) {
      const others = [1, 2, 3].map((k) => clips[(i + k) % clips.length].audio);
      const babble = new Float32Array(c.audio.length);
      for (const o of others)
        for (let j = 0; j < babble.length; j++) babble[j] += o[j % o.length];
      out.push({
        id: c.id,
        set: `${code}-babble-5db`,
        language: code,
        reference: c.reference,
        synthetic: false,
        ...save(`${code}-babble-5db`, c.id, mixAtSnr(c.audio, babble, 5)),
      });

      const white = new Float32Array(c.audio.length);
      for (let j = 0; j < white.length; j++) white[j] = rng() * 2 - 1;
      out.push({
        id: c.id,
        set: `${code}-white-10db`,
        language: code,
        reference: c.reference,
        synthetic: false,
        ...save(`${code}-white-10db`, c.id, mixAtSnr(c.audio, white, 10)),
      });
    }
  }

  for (let i = 0; i < 6; i++) {
    const uz = pcm.uz[i];
    const en = pcm.en[i];
    const audio = concat([uz.audio, en.audio], Math.round(0.5 * RATE));
    out.push({
      id: `mixed-${i}`,
      set: "mixed-uz-en",
      language: "mixed",
      reference: `${uz.reference} ${en.reference}`,
      synthetic: false,
      ...save("mixed-uz-en", `mixed-${i}`, audio),
    });
  }

  for (const [i, t] of TECH.entries()) {
    const aiff = join(OUT, "_pcm", `tech-${i}.aiff`);
    const wav = join(OUT, "_pcm", `tech-${i}.wav`);
    execFileSync("say", ["-v", "Samantha", "-o", aiff, t.text]);
    toPcm16(aiff, wav);
    const audio = readWav(readFileSync(wav)).samples;
    out.push({
      id: `tech-${i}`,
      set: "tech-en-tts",
      language: "en",
      reference: t.text,
      terms: t.terms,
      synthetic: true,
      ...save("tech-en-tts", `tech-${i}`, audio),
    });
  }

  rmSync(join(OUT, "_pcm"), { recursive: true, force: true });
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(out, null, 2));
  const bySet = Object.entries(Object.groupBy(out, (s) => s.set)).map(
    ([set, items]) =>
      `${set.padEnd(16)} ${String(items!.length).padStart(3)} files ${items!
        .reduce((n, s) => n + s.durationSec, 0)
        .toFixed(1)
        .padStart(7)} s`,
  );
  console.log(bySet.join("\n"));
}

main();
