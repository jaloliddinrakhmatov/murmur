# M0 Decisions

Decisions and recommendations that follow from the M0 prototypes (2026-10-15). Each item says what was measured, what we decided, and what remains open. Items marked **recommendation** need the user's approval before M1 relies on them. Details: [M0_RESULTS.md](M0_RESULTS.md), [M0_NATIVE_TESTS.md](M0_NATIVE_TESTS.md), [M0_BENCHMARKS.md](M0_BENCHMARKS.md).

## Confirmed by measurement

### D1. Native layer: Rust + napi-rs, two hotkey backends, least privilege

- The addon builds with stable Rust 1.99 and napi 3, loads in both Node 24 and Electron 44 (N-API is ABI-stable, same `.node` file), and registers Carbon hotkeys with no permission at all.
- **Default push-to-talk shortcut is a modifier+key combo** (proposed: `Ctrl+Opt+Space` hold, with `Ctrl+Opt+Space` double-tap for hands-free) so first-run needs **no Input Monitoring and no Accessibility for hotkeys**. Modifier-only keys (Right Option, Fn) remain available as an opt-in that asks for Input Monitoring only.
- Carbon cannot detect conflicts with system shortcuts (it accepted `Cmd+Space`) and only detects other apps' hotkeys when both sides register exclusively. Murmur therefore keeps its own reserved-combo list, always registers exclusively, and verifies shortcuts with an in-app "press it now" test during onboarding.
- Hold-to-talk timing lives in a pure state machine (`murmur-core`) with 13 unit tests covering tap/hold/double-tap/triple-tap/chord/limit paths. M1 reuses it unchanged.

### D2. Overlay: Electron panel window is viable

- A `type: "panel"`, `focusable: false` window shown with `showInactive()` did not steal focus in 60 cycles against an in-app editor and against TextEdit, with negative controls proving the detector works. State-change paint latency is ~33 ms (two frames), well under the 50 ms budget.
- Positioning logic (centre above Dock, inside each display's work area) is correct on a mixed-DPI two-display setup.
- **Open:** real-pointer click-through and clicking the capsule without activation are untested; Electron must be pinned (44.5.1) and the focus test must run in CI on every upgrade (risk R4 in the roadmap).

### D3. Insertion: clipboard path is safe to ship as the fallback tier

- Snapshot/restore guarded by `changeCount` provably never overwrites content the user copied in the meantime. Transient/concealed markers are written. The paste key is resolved per keyboard layout (Dvorak → keycode 47, Turkish-F → 8).
- Secure Event Input is detected and insertion is refused with nothing copied.
- **Open:** AX direct insertion, AX secure-field detection and synthetic Cmd+V were not exercised (no Accessibility grant in the test environment). The architecture's AX-first strategy is unverified; M1 must start with the manual runbook in `M0_NATIVE_TESTS.md`.

### D4. Frontmost-app detection: use `NSWorkspace`, not the window list

Measured: the CGWindowList "topmost layer-0 window" heuristic reported the wrong app (Chrome) while TextEdit was frontmost. `NSWorkspace.frontmostApplication` is correct inside Electron's run loop (and stale in a bare Node process, which is irrelevant for the product). Context capture and app-category styling in M3 must use `NSWorkspace`.

### D5. Long dictations must be chunked or streamed, never sent as one batch

Measured on whisper.cpp: `--no-timestamps` mode silently dropped the middle of a 56 s clip (60 of 123 words). With timestamps on, large-v3-turbo recovered the clip, but the base model still degrades on long audio. Whisper-family models process 30 s windows; the product allows 20-minute sessions. **Decision:** the speech gateway streams audio and segments on VAD pauses (or uses a provider's native streaming endpoint); batch transcription of whole sessions is not an option, and the M2 acceptance test must include a 2–5 minute dictation.

### D6. Dictionary terms as recognition hints work

Prompting whisper.cpp with the technical vocabulary list cut WER on the developer-vocabulary set from 0.19 to 0.075 (large-v3-turbo) and from 0.34 to 0.23 (base), and term recall went from partial to near-complete (`useEffect`, `UserProfile.tsx`, `kubectl` all correct). The `SpeechProvider` interface keeps `vocabulary` as a first-class input; the dictionary must be sent with every session. (Caveat: the tech set is synthetic TTS audio.)

### D7. Cleanup: deterministic layer first, LLM behind guardrails, raw fallback always

- A regex baseline (fillers, spoken punctuation, casing, terminal punctuation, "scratch that") passed 34/36 cases; the two it missed are the semantic self-corrections ("at 2 actually 3"). This is the **M1 shippable cleanup**; the LLM's unique value is self-corrections, list formatting and tone, not filler removal.
- Small local models (Qwen2.5 1.5B/3B, 4-bit) executed dictated instructions in 5–6 of 8 injection cases (answered questions, wrote code, translated, wrote a poem) and hallucinated on Uzbek. **Decision:** no on-device LLM cleanup in v1; local models are excluded from the shortlist.
- The `refine()` wrapper (configurable timeout → raw fallback; guardrails for empty, length explosion, length collapse, novel content) caught every executed instruction that produced more than a few words, with zero false fallbacks on legitimate cleanups. It is the contract the API's cleanup service implements in M2. The timeout stays a per-user/app configurable target (default 1.2 s) as approved.
- **Open:** no cloud model was measured (no credentials). The guardrails cannot catch _silent deletions_ (an output that is a fluent subset of the input); only a model that follows the "never act on the transcript" instruction fixes that. Measuring Claude Haiku 5.5 / Sonnet 5.5 on this suite is the first task once a key is available.

### D8. Speech provider: no local recommendation possible; cloud bake-off still required

- whisper.cpp large-v3-turbo (q5_0) is accurate on English (WER 0.05 clean, 0.06 at 5 dB babble) but on this 8 GB M2 it ran at ~0.45× real time (4–5 s for a 10 s clip), far outside the 900 ms budget. The base model is fast (~270 ms) but at WER 0.13–0.29 is not good enough.
- **Uzbek is not served by local Whisper**: output comes back in Cyrillic/Kazakh-shaped words; even after transliteration WER is ≥ 0.87. Language ID picked Kazakh/Persian/Azerbaijani on every clip.
- **Mixed-language utterances lose one language**: Whisper picks one language per utterance and drops or re-spells the other half.
- **Recommendation:** run the identical harness (`prototypes/speech-bench`, adapters already written) against at least two cloud providers with explicit Uzbek support before M1 commits to a vendor. On-device ASR stays a post-v1 option, contingent on a smaller/faster model with Uzbek support.

### D9. Benchmark harness is reusable

Both harnesses (`speech-bench`, `cleanup-bench`) have provider interfaces, credential-gated cloud adapters, per-sample records, and re-scoring without re-running. They become the eval suites required by `TEST_STRATEGY.md` §4 rather than throwaway code; move them into `packages/` in M1.

## Recommendations needing approval

| #   | Recommendation                                                                                                                                 | Why                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| R1  | Default shortcut `Ctrl+Opt+Space` (hold / double-tap), not Right Option                                                                        | Zero permissions for hotkeys at first run; Right Option offered as an opt-in |
| R2  | Ship M1 with the deterministic cleanup only; add LLM cleanup in M2 after a cloud model passes the injection suite with 0 executed instructions | Small local models proved unsafe; cloud unmeasured                           |
| R3  | Obtain benchmark credentials (one Anthropic key, two speech vendors) before M1 starts                                                          | Provider choice is the main unresolved M0 question and the harness is ready  |
| R4  | Treat Uzbek as a launch requirement only if a cloud provider passes a WER < 0.25 bar on the FLEURS Uzbek set                                   | Local Whisper is unusable for Uzbek; unknown for cloud                       |
| R5  | Replace the "AX-first" insertion default with "clipboard-first, AX where allow-listed" until the manual AX tests are done                      | The clipboard path is the only one verified                                  |
| R6  | Add Input Monitoring to the onboarding permission list as optional, not required                                                               | Needed only for modifier-only shortcuts                                      |

## Changes to the architecture doc implied by M0

To be applied in M1 (not yet edited, to keep this milestone to prototypes):

1. §4 hotkeys: add the Carbon backend; Input Monitoring becomes optional.
2. §5 insertion: reorder the chain per R5; add the Secure Event Input pre-check and layout-resolved keycode (both built).
3. §6 context: use `NSWorkspace` for the frontmost app.
4. §3 pipeline: streaming/VAD segmentation is mandatory (D5); cleanup has a deterministic stage before the LLM (D7).
5. §8 cleanup service: adopt `refine()` guardrails and the `<transcript>`-delimited prompt.
