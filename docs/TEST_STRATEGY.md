# Test Strategy — Murmur

Status: Proposed (2026-10-15). Applies to the stack in [ARCHITECTURE.md](ARCHITECTURE.md). Acceptance criteria per milestone live in [ROADMAP.md](ROADMAP.md).

## 1. Principles

- The riskiest code is the least testable (native hooks, insertion, overlay focus). Invest there in **real-device automation**, not only mocks.
- Every dictation must be recoverable: tests assert "no lost dictation" across every failure path.
- Cleanup quality is measured with an **eval suite**, not unit asserts on LLM output.
- No real user transcripts in fixtures; use a synthetic, consented corpus.

## 2. Test pyramid

| Layer             | Tooling                                                                                                                               | Scope                                                                                                                                                                                                                                                 | Runs                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Unit              | Vitest                                                                                                                                | `packages/text` (dictionary matching, snippet expansion, punctuation/period rules, word counting incl. CJK), `packages/contracts` schemas, DictationController state machine (every transition + illegal ones), NestJS services with mocked providers | Every PR                           |
| Native unit       | `cargo test`                                                                                                                          | Keycode resolution per layout, clipboard serialization/restore logic, strategy selection                                                                                                                                                              | Every PR (macOS + Windows runners) |
| Integration (API) | Vitest + Testcontainers (Postgres, Redis) + Supertest / WS client                                                                     | Auth flows (PKCE exchange, refresh rotation, revocation), quota enforcement, sync conflicts (409), Stripe webhook idempotency, export/delete jobs, speech gateway with a **fake ASR provider** replaying recorded streams                             | Every PR                           |
| Contract          | zod schemas shared in `packages/contracts`; API responses validated in tests; desktop client tests run against schema-generated fakes | Keeps desktop ↔ API in lockstep                                                                                                                                                                                                                       | Every PR                           |
| E2E (web)         | Playwright                                                                                                                            | Sign up/in, pricing → checkout (Stripe test mode), account settings, team invites, download page OS detection, accessibility (axe)                                                                                                                    | Every PR (smoke), nightly (full)   |
| E2E (desktop UI)  | Playwright `_electron`                                                                                                                | Onboarding screens, Hub CRUD (dictionary/snippets), settings, history retry/undo, offline states — with native addon in **mock mode**                                                                                                                 | Every PR                           |
| Device E2E        | Custom harness on dedicated macOS/Windows machines                                                                                    | Real hotkeys, real insertion into real apps, audio from a virtual mic (BlackHole / VB-Cable) playing corpus files                                                                                                                                     | Nightly + release                  |
| Cleanup evals     | Script in `apps/api/evals` with versioned corpus + LLM-judge + rules                                                                  | Quality regression gate for prompt/model changes                                                                                                                                                                                                      | On prompt/model change + nightly   |
| Performance       | Harness timing each stage via telemetry spans                                                                                         | Latency budget, idle RAM/CPU                                                                                                                                                                                                                          | Nightly + release                  |
| Security          | `/security-audit`, dependency audit, Electron security checklist (fuses, CSP), external pen test before v1                            | —                                                                                                                                                                                                                                                     | Per milestone + pre-release        |

## 3. Critical scenarios (must be automated)

**Dictation lifecycle**

1. Hold → speak → release → text inserted; clipboard restored.
2. Tap < 300 ms → nothing; Esc during listening → nothing, mic closed.
3. Double-tap → hands-free; second press stops; third rapid press cancels.
4. Key pressed while `processing` → handled per spec (queued or rejected with message).
5. 20-minute cap: warning at 19:00, auto-stop + transcribe at 20:00.
6. Silence only → no insertion + "mic muted?" message.
7. Mic unplugged mid-dictation → captured text offered via Insert.
8. Sleep/lock mid-dictation → no crash, dictation recoverable.

**Failure and recovery** 9. Network down at start → audio saved, "Failed" row, Retry succeeds later. 10. Network drops mid-stream → same. 11. ASR error/timeout → one retry then Failed with Retry. 12. LLM timeout → raw text inserted, flagged, Undo AI edit shows raw. 13. LLM output guardrail trip (answers the question / length explosion) → raw inserted. 14. Quota exhausted → blocked before upload, upgrade shown; mid-dictation exhaustion completes current dictation.

**Insertion** 15. Password field → refused, nothing copied. 16. No editable focus → text on clipboard + notice. 17. Focus changes during processing → inserted at focus at key-up rule. 18. Non-QWERTY layout → correct paste. 19. User copies something during the restore window → their copy is not overwritten. 20. Windows elevated target → specific message. 21. macOS Secure Event Input active → hotkey-blocked message.

**Privacy** 22. Training opt-in default false for new users; changes write `PrivacyAuditLog`. 23. Cloud history off → no `CloudDictation` rows created (assert at DB level). 24. Storage mode `off` → no local audio/text persisted after insertion. 25. No transcript text appears in API or client logs (log-scrubbing test with canary phrase). 26. Org policy fetch fails → most restrictive cached policy applied. 27. Account deletion removes user data across tables and object storage (verified by query).

## 4. Cleanup eval suite

- Corpus: ≥ 200 synthetic utterances (recorded by team members with consent, multiple accents, noise levels) across categories: fillers, backtrack, lists, spoken punctuation, numbers/dates/emails/URLs, code identifiers, multilingual, questions to AI tools ("write me a function…" must be transcribed, not answered), profanity, very long monologues.
- Metrics: WER of ASR (per provider), filler-removal rate, meaning preservation (LLM-judge with rubric + 10% human review), forbidden behaviors (answering, adding facts, dropping sentences) = **0 tolerance**, dictionary/snippet application accuracy, latency.
- Gate: a prompt or model change cannot merge if any metric regresses beyond its threshold.

## 5. Insertion app matrix

Maintained as data (`apps/desktop/test/app-matrix.yaml`): app, version, platform, field type, expected strategy, last result.

| Category                                          | macOS                                                     | Windows                                                  |
| ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Browsers (textarea, contenteditable, address bar) | Safari, Chrome, Arc, Firefox, Edge                        | Chrome, Edge, Firefox                                    |
| Web apps                                          | Gmail, Google Docs, Notion, Linear, ChatGPT, Claude       | same                                                     |
| Chat                                              | Slack, Discord, WhatsApp, Messages, Teams                 | Slack, Discord, WhatsApp, Teams                          |
| Email                                             | Mail, Outlook                                             | Outlook (new + classic)                                  |
| Docs                                              | Pages, Word, Notes, TextEdit, Obsidian                    | Word, Notepad, OneNote, Obsidian                         |
| Dev                                               | VS Code, Cursor, Xcode, JetBrains, Terminal, iTerm2, Warp | VS Code, Cursor, JetBrains, Windows Terminal, PowerShell |
| Remote                                            | Microsoft Remote Desktop, Citrix (manual)                 | RDP, Citrix (manual)                                     |
| Hostile                                           | password fields, 1Password, elevated apps (Win)           | same                                                     |

Each cell checks: text exactly equals expected, cursor position after insert, single-step undo, clipboard restored, no focus change, newline handling (no accidental send in chat apps).

## 6. Performance budgets (fail the nightly run if exceeded)

| Metric                                  | Budget                    |
| --------------------------------------- | ------------------------- |
| Key-down → Capsule visible              | ≤ 50 ms                   |
| Key-down → first audio frame            | ≤ 150 ms (p95 ≤ 200 ms)   |
| Release → text inserted, 15 s utterance | p50 ≤ 900 ms, p95 ≤ 1.8 s |
| Idle RSS (all processes)                | ≤ 150 MB                  |
| Idle CPU                                | ≤ 0.5%                    |
| Cold start → ready                      | ≤ 2 s                     |

## 7. Environments and data

- Local: docker-compose Postgres + Redis; fake ASR/LLM providers by default; real providers opt-in via env vars (never committed).
- CI: Testcontainers; GitHub Actions macOS + Windows runners for desktop + native; device lab machines for device E2E.
- Staging: real providers with test accounts, Stripe test mode, staging update channel.
- Migrations run only against local/CI/staging databases per the project safety rules.

## 8. Release testing

- Beta channel with staged auto-update (5% → 25% → 100%), automatic halt if crash-free rate < 99.5% or raw-fallback rate > 5%.
- Manual exploratory checklist per release: fresh-install onboarding on each supported OS version, permission revocation, update-from-previous-version permission retention.
- Accessibility pass on Hub (VoiceOver, NVDA, keyboard-only).
