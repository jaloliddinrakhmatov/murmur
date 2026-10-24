# Roadmap — Murmur

Status: Proposed (2026-10-15). Durations assume 3–4 engineers (desktop/native, backend, web/full-stack, part-time design). Each milestone ends with a demo and its acceptance criteria passing in CI or on the device test matrix.

## Milestone overview

| #   | Milestone                              | Duration | Outcome                                                      |
| --- | -------------------------------------- | -------- | ------------------------------------------------------------ |
| M0  | Foundations & spikes                   | 2 wks    | Monorepo, CI, de-risked native insertion + hotkeys + latency |
| M1  | Walking skeleton (macOS)               | 3 wks    | Hold key → speak → raw text pasted in any app                |
| M2  | Cleanup, dictionary, snippets, history | 3 wks    | Polished text, personal vocabulary, recoverable history      |
| M3  | Insertion hardening & context          | 3 wks    | ≥98% insertion success across top-50 app matrix; styles      |
| M4  | Personalization & sync                 | 2 wks    | Settings, languages, auto-learn, insights, cross-device sync |
| M5  | Windows, billing, teams, web           | 4 wks    | Windows parity, Stripe plans, shared vocab, marketing site   |
| —   | **Private beta → v1.0**                | 2 wks    | Hardening, security audit, launch checklist                  |
| M6  | Power features                         | 3 wks    | Transforms, voice commands, mouse shortcuts                  |
| M7  | Meeting notes                          | 5 wks    | Local meeting capture, transcript, summary, calendar         |

Post-v1 candidates: iOS keyboard, Android, on-device ASR/offline mode, SSO/SCIM, MCP server.

## M0 — Foundations & spikes

- pnpm + Turborepo monorepo per [ARCHITECTURE.md §2](ARCHITECTURE.md#2-monorepo-layout); TS strict; ESLint; Prettier (existing); Vitest; GitHub Actions running lint/typecheck/test on macOS + Windows runners.
- **Spike 1 – native layer:** napi-rs addon with `CGEventTap` hotkey (Right Option hold) and clipboard-paste insertion; measure key-down→callback latency. Decide Rust addon vs Swift/C# sidecar.
- **Spike 2 – overlay:** Electron non-activating Capsule window; prove it never steals focus in 10 target apps.
- **Spike 3 – latency bake-off:** 2–3 streaming ASR providers + 2 LLMs on a 50-utterance internal corpus; record WER and p50/p95 latency; check data-retention terms.

**Acceptance:** CI green on both OSes; written decision record for native approach and providers; spike measurements show a credible path to p50 ≤ 900 ms.

## M1 — Walking skeleton (macOS)

- Electron app with onboarding (sign-in via browser + PKCE, mic + Accessibility + Input Monitoring permissions with deep links, mic test).
- NestJS: auth, users, speech WS gateway → chosen ASR; Postgres via Prisma; Redis.
- DictationController state machine; push-to-talk, hands-free double-tap, Esc cancel; Capsule states.
- Insertion: clipboard paste with restore and transient markers; paste/copy-last hotkeys.
- Signed, notarized `.dmg` with auto-update from a staging feed.

**Acceptance:**

- Fresh macOS 13/14/15 machine: install → first successful dictation in ≤ 3 minutes, no terminal steps.
- Hold-release in TextEdit, Safari, Chrome, Slack, Notes inserts the spoken text; previous clipboard text is restored.
- Tap < 300 ms inserts nothing; Esc during listening inserts nothing and closes the mic.
- Denying a permission shows a recoverable state, never a crash.

## M2 — Cleanup, dictionary, snippets, history

- Cleanup service (Off/Light/Medium), backtrack, spoken punctuation, lists; 1.2 s timeout with raw fallback; guardrails.
- `packages/text`: dictionary corrections, snippet expansion, word counting (CJK aware).
- Hub: Home/History (search, copy, retry, undo AI edit), Dictionary, Snippets.
- Local encrypted audio for retry; 20-minute session cap.

**Acceptance:**

- Cleanup eval set (≥ 200 utterances) — filler removal ≥ 95%, zero "answered the question" failures, meaning-preservation score ≥ 0.95 (LLM-judge + human spot check).
- "Coffee at 2 actually 3" → "Coffee at 3."; "I actually liked it" unchanged.
- Snippet trigger inside a sentence expands; longest trigger wins; dictionary "misheardAs" corrects whole words only.
- Kill the network mid-dictation → History row "Failed" with Retry that succeeds once online.
- LLM forced to time out → raw text inserted, row flagged "Unformatted", undo shows raw.

**Status (2026-10-15): delivered**, see [M2_VERIFICATION.md](M2_VERIFICATION.md).

- Delivered: guarded LLM cleanup (opt-in, Groq/OpenAI/Claude), deterministic cleanup as default and fallback, dictionary and snippets with Hub pages, History search/grouping/compare/export/retention, 20-min cap (M1).
- Not delivered in M2: streaming ASR (still batch), auto-learn. The live-model evaluation is pending credentials; AI cleanup stays off by default until a provider passes (`npm run eval -w packages/refine`).
- Acceptance status: injection regression (recorded M0 outputs) passes except the documented silent-deletion case; "LLM forced to time out → raw text inserted" is now "→ deterministic text inserted, fallback recorded"; the ≥ 200-utterance cleanup eval set is not built (the M0 36-case suite is used).

## M3 — Insertion hardening, context, styles

- Strategy chain (AX direct, Unicode typing, clipboard), layout-aware paste keycode, terminal paste variants, remote-desktop hold, secure-field refusal, Secure Input detection.
- Server `AppCatalog` with category + insertion overrides.
- Context capture (narrow) and Styles by category.

**Acceptance:**

- Automated + manual app matrix (top 50 apps, see [TEST_STRATEGY.md §5](TEST_STRATEGY.md#5-insertion-app-matrix)): ≥ 98% success, 0 insertions into password fields.
- Works with Dvorak and AZERTY layouts.
- Clipboard managers (Raycast, Paste, Maccy) do not record dictations.
- Same utterance yields casual formatting in Slack and formal in Mail per user setting.

## M4 — Personalization & sync

- Settings (shortcuts with conflict detection, mic selection, languages/auto-detect, privacy toggles, storage modes).
- Auto-learn (opt-in), Insights, delta sync of dictionary/snippets/settings with conflict handling.

**Acceptance:** edit on device A appears on device B within 60 s while both online; offline edits sync on reconnect; storage mode "off" purges local history and audio after confirmation.

## M5 — Windows, billing, teams, web

- Windows: `WH_KEYBOARD_LL` hotkeys, `SendInput`/UIA insertion, elevation detection, signed installer, auto-update.
- Stripe plans + quota enforcement (2,000 words/week free), Team workspaces with shared dictionary/snippets and roles.
- Next.js marketing site (home with interactive demo, pricing, download with OS detection, privacy, changelog), account & billing pages, team admin; web demo.
- Data export and account deletion jobs.

**Acceptance:** Windows passes the same M1–M3 acceptance suites (Windows-relevant subset); Stripe test-mode lifecycle (subscribe, upgrade, past-due, cancel) reflected in entitlements within 60 s of webhook; free user blocked at quota with upgrade path; Lighthouse ≥ 90 on marketing pages; export delivered within 24 h.

## v1.0 launch gate

- `/security-audit` and external pen test with no open high/critical findings.
- Privacy policy, DPA, sub-processor list published; provider zero-retention contracts signed.
- Crash-free sessions ≥ 99.5% in beta; raw-fallback rate < 3%; p50 latency ≤ 900 ms, p95 ≤ 1.8 s measured in production telemetry.
- `/deploy-checklist` passed; rollback plan for API and desktop auto-update channel (staged rollout 5% → 25% → 100%).

## M6 — Power features

Transforms (Polish, Shorten, Make list, Translate, ≤8 custom prompts), voice command mode, mouse-button shortcuts, snippet variables.

**Acceptance:** select ≤1,000 words → transform replaces in place with single-step undo in 10 matrix apps; non-editable target → clipboard with notice.

## M7 — Meeting notes

Local mic + system audio capture, consent notice, live transcript, private notes, resumable chunked upload, diarized transcript, summary, Google/Microsoft calendar, duration caps, offline recording.

**Acceptance:** 60-minute two-person call on Zoom/Meet/Teams → summary within 2 min of stop; speaker labels correct ≥ 90% of utterances on eval set; sleep mid-meeting loses ≤ 5 s audio; audio deleted server-side ≤ 7 days.

## Technical risks

| #   | Risk                                                                                                          | Likelihood | Impact | Mitigation                                                                                                 | Owner milestone |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------- | --------------- |
| R1  | Insertion fails or mangles text in key apps (Chromium/Electron AX quirks, terminals, Office, remote desktops) | High       | High   | Strategy chain, per-app catalog updated server-side, app matrix in CI, History always recoverable          | M0, M3          |
| R2  | End-to-end latency > 1.5 s                                                                                    | Medium     | High   | Provider bake-off, pre-warmed WS, streaming ASR, small fast LLM, regional endpoints, 1.2 s cleanup timeout | M0, M2          |
| R3  | macOS TCC permissions lost on update / confusing onboarding                                                   | Medium     | High   | Stable signing identity + bundle id, re-check on every launch, deep links, relaunch helper                 | M1              |
| R4  | Overlay window steals focus after Electron upgrade                                                            | Medium     | High   | Pin Electron, focus-steal regression test, upgrade only via checklist                                      | M1              |
| R5  | LLM cleanup changes meaning / hallucinates / executes the dictated prompt                                     | Medium     | High   | Strict prompt, guardrails, eval suite in CI, raw fallback, undo AI edit                                    | M2              |
| R6  | Global hook removed by Windows (timeout) or blocked by Secure Input on macOS                                  | Medium     | Medium | Non-blocking callbacks, hook watchdog, Secure Input detection + message                                    | M1, M5          |
| R7  | Clipboard restore races corrupt user's clipboard                                                              | Medium     | Medium | changeCount checks, per-app delays, transient markers, never restore if user copied after us               | M1, M3          |
| R8  | ASR/LLM unit cost makes free tier unprofitable                                                                | Medium     | Medium | Cost/word metric from M1, cap free tier, cheaper model for Light cleanup                                   | M2, M5          |
| R9  | Privacy/compliance exposure (transcripts are highly sensitive)                                                | Low        | High   | Privacy-forward defaults, no server audio, PII-free logs, zero-retention vendors, security audit gate      | All             |
| R10 | Electron footprint criticized (RAM, size)                                                                     | Medium     | Low    | Single hidden audio renderer, lazy-load Hub, measure idle RSS in CI                                        | M1              |
| R11 | Meeting recording consent laws (two-party consent jurisdictions)                                              | Medium     | High   | Consent notice, optional announcement text, admin policy, legal review before M7                           | M7              |
| R12 | Rust native skills bottleneck                                                                                 | Medium     | Medium | M0 spike decides addon vs sidecar; keep native API surface small and typed                                 | M0              |

## Definition of done (every milestone)

- Acceptance criteria above pass and are automated where feasible.
- `npx prettier --check .`, lint, typecheck, and tests green on macOS and Windows CI.
- New behavior documented (`/document-feature`); the commands table updated.
- No transcript text in logs; new data fields reviewed against the privacy model.
