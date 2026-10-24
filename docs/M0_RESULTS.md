# M0 Results

Milestone 0 built five technical prototypes to de-risk Murmur before M1. This is the summary; evidence and numbers are in [M0_NATIVE_TESTS.md](M0_NATIVE_TESTS.md) and [M0_BENCHMARKS.md](M0_BENCHMARKS.md), and the resulting decisions in [M0_DECISIONS.md](M0_DECISIONS.md). Code and run instructions: [`prototypes/README.md`](../prototypes/README.md).

Date: 2026-10-15. Machine: Apple M2, 8 GB RAM, macOS 27.0.1. All numbers were measured in this session; nothing was estimated. Cloud providers were **not** measured because no credentials were present in the environment.

## Verdicts

| Prototype                       | Verdict     | One-line reason                                                                                                                                                                                                 |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Native keyboard integration | **PARTIAL** | Registration, unregistration, validation, conflicts and the hold-to-talk state machine are tested (46 automated tests); live key delivery needs a human key press and Input Monitoring, neither available here. |
| B — Floating overlay            | **PASS**    | 10/11 automated checks pass including no-focus-steal against an external app with negative controls; real-pointer click-through untested.                                                                       |
| C — Text insertion              | **PARTIAL** | Clipboard tier verified end to end (restore guard, transient markers, layout-aware paste key, secure-input rejection); Accessibility tier and synthetic paste untested (no Accessibility grant).                |
| D — Speech recognition          | **PARTIAL** | Provider-independent harness works and measured two local models on 92 clips in 10 sets; cloud providers blocked on credentials, so no vendor recommendation.                                                   |
| E — LLM refinement              | **PARTIAL** | Harness, guardrails, configurable timeout and raw fallback work and are tested; local models measured and rejected; cloud models blocked on credentials.                                                        |

## What was built

| Area                                                                                                                                                                                                   | Location                      | Tests                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------- |
| Rust core (shortcut parsing/validation/conflicts, hold-to-talk state machine)                                                                                                                          | `native/crates/murmur-core`   | 23 `cargo test`                                   |
| napi-rs addon: Carbon hotkeys, listen-only event tap, permissions, frontmost app, AX focus/insert, clipboard snapshot/restore, layout paste key, insertion chain                                       | `native/crates/murmur-native` | 23 Node tests (1 skipped: needs Input Monitoring) |
| Electron Capsule overlay + self-test + interactive hold-to-talk demo                                                                                                                                   | `prototypes/overlay`          | 11-check self-test                                |
| Speech benchmark: `TranscriptionProvider` interface, whisper.cpp + OpenAI-compatible + Deepgram adapters, sample builder, WER/CER/latency/RTF/language-ID/term-recall/Uzbek-script metrics, re-scoring | `prototypes/speech-bench`     | 5 unit tests                                      |
| Cleanup benchmark: `CleanupProvider` interface, rules baseline, llama.cpp + Claude adapters, `refine()` with timeout/guardrails/fallback, 36 cases in 9 categories                                     | `prototypes/cleanup-bench`    | 12 unit tests                                     |
| Reproducible local setup (pinned whisper.cpp v1.9.4, llama.cpp b11306, FLEURS en/uz clips, Qwen2.5 1.5B/3B)                                                                                            | `prototypes/scripts`          | —                                                 |

## Headline findings

1. **Hotkeys need no permission for modifier+key combos.** Carbon `RegisterEventHotKey` works without TCC prompts and delivers press and release. Modifier-only keys (Right Option, Fn) need the event tap and therefore Input Monitoring only, never Accessibility. Carbon does not detect conflicts with system shortcuts (`Cmd+Space` was accepted), so Murmur keeps its own reserved list.
2. **The Electron panel overlay does not steal focus.** 0 violations in 60 cycles against an in-app editor and TextEdit; both negative controls fired. State paint ≈ 33 ms.
3. **Clipboard insertion is safe.** The restore step is refused whenever the clipboard changed after our write (verified), dictated text carries transient/concealed markers, the paste keycode is layout-resolved (Dvorak → 47, Turkish-F → 8), and Secure Event Input blocks insertion with nothing copied.
4. **`NSWorkspace`, not the window list, identifies the frontmost app.** The first implementation was wrong and was caught by the overlay test.
5. **Local Whisper is accurate for English but too slow on this hardware and unusable for Uzbek.** large-v3-turbo: WER 0.049 clean, 0.057 at 5 dB babble, but 4.3 s per 9 s clip (RTF 0.44). base: 270 ms but WER 0.125–0.29. Uzbek: WER ≈ 1.0 raw and ≥ 0.87 after transliteration; language ID never returned Uzbek. Mixed Uzbek/English utterances lose one language.
6. **Vocabulary hints matter.** Passing the dictionary as a prompt cut technical-vocabulary WER from 0.19 to 0.075 (term recall 0.5 → 0.95).
7. **Long audio needs streaming/segmentation.** whisper.cpp's no-timestamps mode dropped the middle of a 56 s clip (60/123 words); with timestamps the large model recovered it (WER 0.087), the base model did not (0.34).
8. **Small local LLMs are unsafe as a cleanup layer.** Qwen2.5 1.5B/3B executed dictated instructions in 5–6 of 8 injection cases (answered "Paris", wrote Python, translated to Spanish, wrote a poem) and hallucinated on Uzbek. A regex baseline passed 34/36 cases; the misses are semantic self-corrections, which is exactly where an LLM is needed.
9. **Guardrails + raw fallback work as designed.** Every answer, translation, code block, poem and one-word reply was replaced by the raw transcript, lifting the local models from 0.64–0.67 to 0.78–0.81; the only two fallbacks the scorer counted as "false" were in fact real deletions the lenient scoring had missed. Silent deletions of a fluent subset (dropping "summarize the following email") remain undetectable by heuristics.

## Blockers and gaps

| Blocker                                                               | Impact                                                                                               | Resolution                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| No API credentials (speech vendors, Anthropic)                        | No cloud latency/quality/cost numbers; no provider recommendation (as approved: providers stay open) | Provide keys; harnesses run unchanged (`prototypes/README.md`)                  |
| No Accessibility / Input Monitoring granted to the test process       | AX insertion, event-tap hotkeys, synthetic paste, live key delivery untested                         | 10-minute manual runbook in `M0_NATIVE_TESTS.md`, granting to Terminal.app only |
| 8 GB RAM with heavy swapping                                          | Local-model latencies are pessimistic for a typical 16 GB machine                                    | Re-run `speech-bench` on a 16 GB Mac before judging on-device feasibility       |
| Synthetic TTS for the technical set; no real code-switched recordings | Tech and mixed-language results are indicative only                                                  | Record 20–30 real clips per set in M1 (consented team recordings)               |

## Final test run

| Suite               | Command                                    | Result                 |
| ------------------- | ------------------------------------------ | ---------------------- |
| Rust core           | `cargo test -p murmur-core`                | 23 passed              |
| Native addon (Node) | `npm test` in `native`                     | 22 passed, 1 skipped   |
| Overlay self-test   | `npm run selftest` in `prototypes/overlay` | 10 PASS, 1 NOT-TESTED  |
| Speech harness      | `npm test` in `prototypes/speech-bench`    | 5 passed               |
| Cleanup harness     | `npm test` in `prototypes/cleanup-bench`   | 12 passed              |
| Formatting          | `npx prettier --check .`                   | see M0 summary message |

Nothing from M1 was started: no authentication, billing, marketing site, dashboard, or meeting notes code exists.
