# M1 Verification Report

Date: 2026-10-15. Machine: Apple M2, 8 GB, macOS 27.0.1, Electron 44.5.1 (Node 24.21), Rust 1.99. Everything below was run in this session; anything a human must do is listed under **Not verified** with the manual procedure in [M1_MANUAL_TESTS.md](M1_MANUAL_TESTS.md).

## Scope delivered

The primary workflow (focus field → hold shortcut → record → Capsule status → release → transcribe → deterministic cleanup → insert → recoverable History) is implemented as a macOS Electron app with a Rust/napi-rs native addon and SQLite History. Approved decisions applied: `ctrl+opt+space` default (configurable, modifier+key only), deterministic cleanup only, clipboard-first insertion, no server-side audio, cloud history and training fixed off, no meeting notes.

**Deviation from the roadmap's original M1 line items:** no NestJS API, sign-in, or signed/notarized `.dmg`. The brief scoped M1 to the desktop workflow; the app calls transcription providers directly through the `TranscriptionProvider` interface, so a gateway can be inserted later without touching the controller. Packaging/signing needs an Apple signing identity that is not available; the app runs from `npm start` / `npm run dev`.

**R5/R6 handling:** R5 (clipboard-first) was approved and is implemented: Accessibility insertion is disabled in the native chain (`allowAccessibility: false`). R6 (Input Monitoring for modifier-only shortcuts) was **not** approved, so Settings refuses modifier-only combos with "needs-input-monitoring (not available in this version)" and never requests Input Monitoring.

## Automated results

| Suite                                                                                                                        | Command                                             | Result                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| `@murmur/text` (cleanup, word count)                                                                                         | `npm test -w packages/text`                         | 10 passed                                               |
| `@murmur/speech` (providers, WAV, config)                                                                                    | `npm test -w packages/speech`                       | 6 passed                                                |
| `@murmur/desktop` unit + integration (controller with the real native hold machine, stores, adapters against the real addon) | `npm test -w apps/desktop`                          | 26 passed                                               |
| `@murmur/native` (Rust core + Node addon)                                                                                    | `npm test -w native`                                | 23 + 22 passed, 1 skipped (needs Input Monitoring)      |
| Type-check (all workspaces)                                                                                                  | `npm run typecheck`                                 | clean                                                   |
| Electron smoke                                                                                                               | `npm run smoke` → `apps/desktop/results/smoke.json` | **20 checks, 0 failed, 0 not tested**                   |
| Real app boot (`electron .`, 10 s)                                                                                           | —                                                   | starts, binds `Ctrl+Opt+space`, tray created, no errors |

### Smoke test detail (real Electron, real addon, real SQLite/vault/clipboard; fake microphone and provider where noted)

| Check                                                                              | Result | Measured                                                     |
| ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| Capsule window: always-on-top, not focusable, visible on all workspaces            | PASS   |                                                              |
| Capsule first paint after launch (cold)                                            | PASS   | 41.9 ms (one earlier run: 75.6 ms)                           |
| Capsule paint latency, 20 warm transitions                                         | PASS   | p50 20.0 ms, p95 20.7 ms (budget ≤ 50)                       |
| Push-to-talk registered through Carbon with no permission                          | PASS   | `Ctrl+Opt+f12` (smoke uses F12 to avoid the user's shortcut) |
| Esc free while idle, held while recording                                          | PASS   | exclusive re-registration → 0 / −9878                        |
| Hold → release: cleaned text, History row `inserted`, audio deleted after success  | PASS   | "um smoke test comma works" → "Smoke test, works."           |
| Inserter receives the release-time target                                          | PASS   |                                                              |
| Cancel during recording stores nothing                                             | PASS   |                                                              |
| Provider failure (HTTP 503): row `failed`, encrypted audio kept                    | PASS   | AES-GCM file > 44 bytes, no plaintext header                 |
| Retry re-transcribes stored audio and **copies** (never pastes)                    | PASS   | row → `copied`                                               |
| Silence not transcribed or stored                                                  | PASS   | peak RMS 0.0004                                              |
| Tap < 300 ms ignored                                                               | PASS   |                                                              |
| Secure field: rejected, clipboard untouched (real native inserter)                 | PASS   | change count unchanged                                       |
| App switched after release: copy-only with hint                                    | PASS   |                                                              |
| Clipboard never overwritten by restore when newer content exists (real pasteboard) | PASS   |                                                              |
| **Real microphone capture**, 400 ms through the hidden renderer + AudioWorklet     | PASS   | 16 kHz PCM, 400 ms, peak RMS 0.051                           |
| No focus steal vs TextEdit, 20 state changes (LaunchServices frontmost check)      | PASS   | 0 violations                                                 |
| Hub renders Settings (Permissions, Shortcut, Transcription)                        | PASS   |                                                              |

### Reliability requirements → where each is enforced and tested

| Requirement                                     | Enforcement                                                                                                             | Test                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Never insert into password fields               | `decideInsertion`: Secure Event Input or AX secure field → `rejected`, nothing copied                                   | adapters (real addon, secure input enabled), smoke, controller |
| Never silently insert into an unverified target | Target snapshot at release; frontmost app re-checked at insertion; mismatch → copy with "App changed" hint              | adapters, controller, smoke                                    |
| Never overwrite newer clipboard content         | `clipboardRestore` refuses when `changeCount` moved                                                                     | native tests, smoke                                            |
| Preserve recoverable transcripts after failures | History row + encrypted audio on every provider failure/timeout; Retry from Hub                                         | controller (503, timeout, not-configured), smoke               |
| Handle recording cancellation                   | Esc (Carbon, armed only while recording), Capsule ✕, tap cancel, chord cancel                                           | controller, adapters, smoke                                    |
| Handle microphone permission denial             | `NotAllowedError` → "Microphone access is off — open Settings"; machine reset; next dictation works                     | controller, adapters (error mapping)                           |
| Handle shortcut conflicts                       | Validation (system-reserved list), exclusive registration, −9878 → "already used by another app", previous binding kept | adapters (real conflict), Settings UI                          |
| Handle provider failures and timeouts           | `AbortSignal.timeout(settings.speech.timeoutMs)`; failures never pretend success; unconfigured provider → setup error   | speech + controller tests                                      |
| Keep the Capsule from stealing focus            | `type: "panel"`, `focusable: false`, `showInactive()`                                                                   | smoke vs TextEdit                                              |

## Manually verified by the user (2026-10-15, macOS 27.0.1)

| Item                                                                      | Result             | Evidence                                                                                                            |
| ------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Physical key delivery of the Carbon hotkey inside Electron (hold/release) | **PASS**           | Dictations recorded on `ctrl+opt+space`; a quick triple-press produced `dictation.too-short` as designed            |
| Real microphone recording                                                 | **PASS**           | 4.6 s, 10.6 s and 13 s dictations captured                                                                          |
| Cloud provider end to end (Groq, `whisper-large-v3-turbo`)                | **PASS**           | "Can you tell me about yourself?" and a 13 s sentence transcribed and cleaned                                       |
| Provider error surfaced, audio kept, retry offered                        | **PASS**           | OpenAI key without credits → row `failed` with `HTTP 429 … no credits remaining`, **Retry transcription** available |
| Real paste via synthetic ⌘V with Accessibility granted                    | **PASS**           | Status `inserted`; text appeared in TextEdit after clicking into it                                                 |
| Setup/Settings UI (permissions, provider, shortcut)                       | **PASS** after fix | See bugs below                                                                                                      |

### Bugs found by manual testing and fixed

1. **Hub buttons invisible (white on white).** The React UI used Tailwind v3's `bg-[--var]` syntax, which Tailwind v4 ignores, so primary buttons (Continue, Save) had no background. Fixed (`bg-(--var)`); the smoke test now asserts a primary button has a visible background.
2. **Dictating with the Murmur window focused pasted into Murmur itself** (History showed "→ Electron"). The inserter now refuses its own process as a target and shows "Click into another app first — copied, press ⌘V". Unit-tested.
3. Menu-bar icon was too small to notice; enlarged.

## Not verified (needs a human)

| Item                                                                 | Why it cannot be automated here                                                             | Manual test          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------- |
| Clipboard restoration timing and the "newer copy" case in a real app | Needs a human copy during the restore window                                                | M1_MANUAL_TESTS #7–8 |
| Browser inputs and browser password fields (Safari/Chrome)           | Secure Event Input covers native fields; web password inputs unverified (M0 caveat)         | #6, #9–10            |
| Application switching while holding / during processing              | Needs a second app                                                                          | #11–12               |
| Microphone denial flow in the real TCC dialog                        | Electron has mic access on the test machine; tested only with a simulated `NotAllowedError` | #18                  |
| Capsule level meter, cancel button, hands-free via double-tap        | Visual/physical                                                                             | #3, #4, #14          |

## Known limitations

1. Transcription is batch per utterance (audio uploaded after release), not streaming; latency is provider round-trip plus upload. Streaming is M2.
2. Deterministic cleanup does not resolve self-corrections ("at 2 actually 3") or format lists; those need the LLM layer (M2, after the injection suite passes).
3. Without Accessibility, every dictation ends as "Copied — press ⌘V". The Hub says so and offers the permission.
4. The local whisper.cpp path is for development: M0 measured it outside production latency on this hardware.
5. Not packaged or signed; TCC grants apply to the Electron dev binary. The user-data directory is `~/Library/Application Support/Electron` until packaged.
6. One pre-existing Prettier warning set in `.claude/` tooling files is untouched (not part of this work).

## Artifacts

- Code: `apps/desktop`, `packages/text`, `packages/speech`, `native` (moved from `prototypes/native`, unchanged except the `action` option on `registerHotkey`).
- Results: `apps/desktop/results/smoke.json`, `native/results/native-measurements.json`.
- Docs: [README.md](../README.md) (setup, environment configuration), [M1_MANUAL_TESTS.md](M1_MANUAL_TESTS.md), `apps/desktop/.env.example`.
