# Product Requirements — Murmur

Status: Draft v0.1 (2026-10-15). Codename **Murmur** is a placeholder pending trademark clearance.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) · [ROADMAP.md](ROADMAP.md) · [TEST_STRATEGY.md](TEST_STRATEGY.md)

## 1. Product summary

Murmur is a desktop voice-writing tool: hold a key, speak naturally, release, and clean, well-formatted text appears in whatever app has focus. It learns the user's vocabulary, adapts tone to the app, and keeps the user in control of their data.

We are building an **original** product in an established category. We use the reference audit to understand user expectations and failure modes, not to reproduce another product's UI, copy, or assets.

### Goals

1. Release-to-text latency that feels instant: **p50 ≤ 900 ms, p95 ≤ 1.8 s** for a 15-second utterance.
2. Insertion that works in the top 50 desktop apps (browsers, Slack, Mail/Outlook, Notion, Docs, VS Code/Cursor, terminals) at a ≥ 98% success rate.
3. Privacy that users can explain in one sentence: _"Audio is processed then discarded; nothing trains on my data unless I opt in."_

### Non-goals (v1)

- Mobile apps (iOS keyboard extension, Android accessibility service). Planned post-v1.
- Linux. On-premise deployment. Fully on-device ASR (designed for, not shipped).
- Bot-based meeting capture (we capture locally only).

### Personas

- **Knowledge worker** — writes Slack, email, docs all day; wants speed and tone fit.
- **Developer** — dictates prompts to AI coding tools; needs identifiers spelled right and terminals to work.
- **Accessibility user** — RSI or motor impairment; needs reliable hands-free mode and full keyboard/screen-reader support in our own UI.
- **Team admin** — buys seats, manages shared vocabulary and data policy.

## 2. Product decisions that differ from the reference

These are deliberate. Each needs sign-off (see open questions).

| Topic                 | Reference behavior                        | Murmur decision                                                                                             | Why                                                |
| --------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Training on user data | On by default for Free/Pro                | **Off by default**; explicit opt-in                                                                         | Trust is our differentiator; simplifies GDPR basis |
| Cloud history         | On by default                             | **Off by default** (local history only); opt-in sync                                                        | Minimizes stored sensitive data                    |
| Audio retention       | 14 days for retry                         | **Local only**, 7 days, never uploaded for storage                                                          | Retry works without server-side audio              |
| Context capture       | On by default, includes on-screen text    | On by default but **limited to app id, URL host, and ±500 chars around cursor**; full-window text is opt-in | Smaller blast radius                               |
| Brand / UI            | Floating bubble, specific visual language | Our own "Capsule" indicator, own palette, iconography, sounds, copy                                         | Originality, no trade-dress risk                   |

## 3. Feature specifications

Each feature lists: **user action → UI states → data model → backend behavior → errors → permissions → edge cases**. Priority: P0 = MVP, P1 = v1.0, P2 = later.

### F1. Onboarding and permissions (P0)

- **User action:** install → launch → sign in (browser hand-off) → grant permissions → mic test → pick shortcut → pick languages → privacy choices → guided practice dictation → done.
- **UI states:** each step is a full-window card with progress; steps already satisfied are skipped; resumable from last incomplete step after quit.
- **Data:** `OnboardingState { step, completedAt, permissions: {mic, accessibility, inputMonitoring} }` in local store; server `User.onboardedAt`.
- **Backend:** OAuth/OIDC via browser; desktop receives a one-time code over a custom URL scheme (`murmur://auth/callback`) and exchanges it with PKCE for tokens.
- **Errors:** sign-in timeout (retry button), permission denied (deep link to the exact System Settings pane + "I've enabled it" re-check), "No microphone found", "Microphone in use by another app".
- **Permissions:** macOS Microphone, Accessibility (insertion + context), Input Monitoring (global key hook). Windows Microphone only.
- **Edge cases:** permission granted but app needs relaunch (macOS sometimes requires it) → detect and offer "Relaunch Murmur"; permissions revoked after an update (re-signed binary) → re-run the permission step on launch; MDM-pre-approved Accessibility.

### F2. Capsule (floating indicator) (P0)

- **User action:** passive; click to start/stop; right-click for menu (hide 1 h, paste last, open history, settings).
- **UI states:** `hidden` → `resting` (small, translucent) → `listening` (live input level meter, elapsed time, stop + cancel) → `processing` (indeterminate) → `inserted` (brief check, 600 ms) → `error` (message + action, e.g. Retry / Copy / Open settings) → `resting`. Also `quotaExceeded`, `offlineQueued`, `permissionMissing`.
- **Data:** per-device prefs `{ capsuleVisible: always|whileActive|hidden, hiddenUntil }`.
- **Backend:** none.
- **Errors:** shown inline in the capsule card; never as modal dialogs.
- **Permissions:** none beyond F1.
- **Edge cases:** must never take keyboard focus from the target app; follows the display containing the cursor; avoids Dock/taskbar/menu bar; full-screen apps; excluded from screen capture during meeting recording (optional); multi-DPI displays.

### F3. Push-to-talk and hands-free dictation (P0)

- **User action:** hold shortcut and speak, release to insert. Double-tap shortcut (or a dedicated toggle) for hands-free; press again to stop. `Esc` cancels.
- **UI states:** as F2; hands-free shows a persistent stop control.
- **Data:** per-device `ShortcutBinding { action, keys[], mouseButton? }` (max 4 per action, 3 keys per combo).
- **Backend:** opens streaming ASR session on key-down (pre-warmed connection), closes on release.
- **Errors:** tap < 300 ms → ignore silently; silence detected → "Didn't catch that — is your mic muted?"; mic unplugged → stop and offer Insert for captured text; session > 20 min → warn at 19 min, auto-stop at 20.
- **Permissions:** Input Monitoring (macOS) for global hook.
- **Edge cases:** macOS Secure Event Input active → detect and show "Another app is blocking shortcuts (likely a password field)"; key-up lost (sleep, fast app switch) → watchdog auto-releases after 10 s of no key events; hotkey pressed while previous dictation is processing → queue up to 1, otherwise reject with message; shortcut conflicts with OS-reserved combos → block at binding time.

### F4. Transcription and cleanup (P0)

- **User action:** none beyond speaking.
- **UI states:** `listening` (optional live partial transcript in capsule, P1) → `processing`.
- **Data:** `Dictation { id, startedAt, durationMs, language, rawTranscript, finalText, cleanupLevel, styleId, appId, urlHost, wordCount, status, error? }` stored locally; cloud copy only if sync is on.
- **Backend:**
  1. Stream 16 kHz mono PCM/Opus over WebSocket to the API's speech gateway → streaming ASR provider with dictionary terms as keyword boosts.
  2. On end-of-audio, final transcript + context + dictionary + style → LLM cleanup with strict instructions (remove fillers, apply backtrack, format lists, apply spoken punctuation, never add content).
  3. Deterministic post-processing: dictionary corrections, snippet expansion, trailing-period rule per style.
  4. Return `finalText` + `rawTranscript`; increment usage.
- **Errors:** ASR timeout → retry once, then save audio locally and show "Couldn't transcribe — Retry"; LLM failure/timeout (budget 1.2 s) → **insert raw transcript** and flag the row "Unformatted"; quota exceeded → refuse before upload and show upgrade.
- **Permissions:** network.
- **Edge cases:** LLM output drifts (answers the dictated question instead of transcribing it) → guardrail checks length ratio and semantic similarity, falls back to raw; dictating into AI chat apps → minimal cleanup; empty transcript → no insert; profanity preserved as spoken; numbers/dates/emails/URLs normalized.

### F5. Text insertion (P0)

- **User action:** none; text appears at the cursor.
- **UI states:** `inserted` or `error: Couldn't paste here — text copied` with Copy/Open history.
- **Data:** `InsertionAttempt { strategy, targetAppId, success, latencyMs }` (local telemetry, metadata only).
- **Backend:** none; native layer. Strategy chain (see [ARCHITECTURE.md §5](ARCHITECTURE.md#5-native-text-insertion)): accessibility direct insert → clipboard paste with restore → simulated Unicode typing (short text / paste-hostile fields).
- **Errors:** secure/password field → refuse, do not copy; no focused editable element → keep on clipboard + "Paste last" hint; Windows elevated target → "Run Murmur as administrator to type into this app".
- **Permissions:** Accessibility (macOS).
- **Edge cases:** user changed focus during processing → insert into field focused at release only if it still exists, otherwise copy; clipboard managers (mark transient/concealed); non-QWERTY layouts; terminals needing `Ctrl+Shift+V`; remote desktop clients (longer clipboard hold); rich text vs plain text targets; very long text (chunking).

### F6. Personal dictionary (P0) and auto-learn (P1)

- **User action:** add word (+ optional "often heard as"); edit; delete; bulk delete; search. Auto-learn suggests words after user edits a just-inserted dictation.
- **UI states:** list with personal/team tabs, empty state, inline validation, sync spinner, conflict toast.
- **Data:** `DictionaryEntry { id, ownerType: user|team, ownerId, phrase(≤60), misheardAs?(≤60), source: manual|learned|imported, usageCount, createdAt, updatedAt, deletedAt? }`, unique on `(ownerType, ownerId, lower(phrase))`.
- **Backend:** CRUD + delta sync (`GET /dictionary?since=`), soft delete for sync tombstones.
- **Errors:** duplicate, too long, empty/punctuation-only, network failure (keep local, retry).
- **Permissions:** auto-learn needs Accessibility to re-read the field after insertion.
- **Edge cases:** personal vs team duplicate (personal wins), never learn from password fields/URLs/code/numbers, deleted words never auto-relearned, cap entries per user (e.g. 2,000) to bound prompt size.

### F7. Snippets (P0)

- **User action:** create trigger → expansion; say the trigger while dictating.
- **UI states:** list, editor with basic rich text (bold, italic, lists, links), preview, validation.
- **Data:** `Snippet { id, ownerType, ownerId, trigger(≤60), expansionMarkdown(≤4000), createdAt, updatedAt, deletedAt? }`.
- **Backend:** CRUD + delta sync; matching happens client-side after cleanup (deterministic, longest-trigger-wins, word-boundary, case-insensitive).
- **Errors:** trigger collides with another snippet or a dictionary phrase; trigger is a common word (warn).
- **Edge cases:** trigger said mid-sentence; expansion contains formatting but target accepts plain text only; LLM cleanup must not paraphrase triggers (pass them as protected tokens).

### F8. Styles (P1)

- **User action:** pick a tone per app category (Personal chat / Work chat / Email / Documents / Other); override per specific app.
- **Data:** `StylePreference { userId, category, tone: formal|neutral|casual|relaxed }`, `AppCategoryOverride { userId, appId, category }`; server-maintained `AppCatalog { bundleIdOrExe, urlHost?, defaultCategory }`.
- **Backend:** resolve category from `appId`/`urlHost`, pass tone instructions to the cleanup prompt.
- **Edge cases:** unknown app → Other; non-English → style limited to punctuation/casing rules.

### F9. Transforms and voice commands (P2)

- **User action:** select text → press transform shortcut (built-ins: Polish, Shorten, Make list, Translate) or hold command shortcut and speak an instruction.
- **Data:** `TransformPrompt { id, userId, name, instruction, shortcut, examples[] }` (max 8).
- **Backend:** `POST /transforms/run` (text ≤ 1,000 words) → LLM → replaced text; diff view available.
- **Errors:** no selection and empty field, too long, provider busy.
- **Edge cases:** reading the selection requires Accessibility or a synthetic copy (clobbers clipboard → restore); undo must be one `Cmd+Z`.

### F10. History (P0)

- **User action:** browse/search past dictations, copy, retry, undo AI edit (show raw), delete, export audio (P1).
- **UI states:** grouped by day; row statuses `ok | unformatted | failed | cancelled`; empty, loading, "History disabled" when storage is off.
- **Data:** local SQLite `dictations` table (F4) + local audio files (7 days) with storage modes `keep | 24h | off`.
- **Backend:** optional sync when cloud history is enabled.
- **Errors:** audio expired → retry disabled with reason; retry while dictating → blocked.
- **Edge cases:** storage mode changed to `off` → purge existing data after confirmation; disk full; encryption at rest via OS keychain-wrapped key.

### F11. Insights (P1)

- WPM (median over last 100 dictations, silence-trimmed), total words, words this week vs quota, streaks, top apps by category. Computed locally from history + server aggregates (`UsageDaily`), so it works with cloud history off.
- Edge cases: CJK word counting, timezone changes for streaks, history disabled (use server aggregates only).

### F12. Settings and account (P0)

- **Sections:** General (shortcuts, microphone, languages), Writing (cleanup level, styles), Privacy & Data (training opt-in, cloud history, context capture level, local storage mode, export, delete), System (launch at login, capsule visibility, sounds, updates), Account (profile, sign out, delete account), Plan & Billing (opens web).
- **Backend:** `UserSettings` JSON (synced subset), `PrivacySettings` columns (auditable), account deletion as async job with 30-day grace.
- **Edge cases:** org policy locks a setting (show lock icon + reason); sign-out wipes local data after confirmation.

### F13. Privacy, compliance, data rights (P0 baseline, P1 full)

- Data export (JSON + audio where held) delivered as a signed URL valid 7 days; deletion within 30 days; audit trail of privacy setting changes; fail-closed when policy can't be fetched (treat as most restrictive cached policy).

### F14. Plans, quota, billing (P1)

- Free: 2,000 words/week; Pro: unlimited; Team: per-seat with shared dictionary/snippets and admin console.
- **Data:** `Subscription { orgId|userId, plan, status, periodEnd, providerCustomerId }`, `UsageWeekly { userId, weekStart, words }`.
- **Backend:** Stripe Checkout + Customer Portal; webhooks are the source of truth; quota checked at session start and enforced server-side on completion.
- **Edge cases:** quota hit mid-dictation (finish that dictation, block the next), past-due grace period, plan downgrade with shared content (becomes read-only).

### F15. Marketing site and download (P0)

- Pages: Home (interactive before/after demo), Pricing, Download (OS detection, direct `.dmg`/`.exe` links, checksum), Privacy & Security, Changelog, Sign in/Sign up, Account, Legal.
- Web demo (P1): browser dictation using the same API with an anonymous, rate-limited token.

### F16. Meeting notes (P2)

- **User action:** start recording manually (or accept a detected-call prompt), see live transcript, add private notes, stop → summary.
- **UI states:** `setupIncomplete → ready → recording → stopping → uploading → processing → ready | failed`; offline recording queue.
- **Data:** `Meeting { id, userId, title, startedAt, endedAt, calendarEventId?, status }`, `MeetingSegment { meetingId, seq, audioKey, durationMs }`, `Utterance { meetingId, speakerLabel, startMs, endMs, text }`, `MeetingSummary { meetingId, markdown, model, generatedAt }`, `MeetingNote { meetingId, body }`.
- **Backend:** chunked upload of local audio (resumable), batch diarized transcription job, summary job (queue), audio deleted after processing (≤ 7 days).
- **Permissions:** macOS 14.4+ system audio tap permission (13.x: Screen Recording); Windows none extra. Calendar OAuth (Google/Microsoft) optional.
- **Errors/edge cases:** consent notice before first recording + optional "announce in chat" text; sleep/lock mid-meeting; disk full; network loss (record locally, process later); back-to-back meetings; duration cap (default 2 h, max 3 h).

## 4. Non-functional requirements

| Area          | Requirement                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Latency       | See goals. Capsule appears ≤ 50 ms after key-down; audio capture starts ≤ 100 ms after key-down (pre-roll buffer covers the gap).           |
| Reliability   | ≥ 99.5% dictations produce text (raw fallback counts); zero lost dictations — every failure is recoverable from History while audio exists. |
| Resource use  | Idle desktop app ≤ 150 MB RSS, ≤ 0.5% CPU.                                                                                                  |
| Security      | TLS 1.3, tokens in OS keychain, signed + notarized builds, hardened runtime, CSP in renderers, `contextIsolation` on, no Node in renderers. |
| Privacy       | No audio persisted server-side for dictation; provider contracts with zero retention / no training.                                         |
| Accessibility | Hub UI meets WCAG 2.2 AA; all actions keyboard-reachable; screen-reader labels on capsule states.                                           |
| i18n          | ASR in 50+ languages at launch (provider-dependent); UI English first, externalized strings from day one.                                   |
| Platforms     | macOS 13+ (Apple Silicon + Intel), Windows 10 22H2+/11 x64.                                                                                 |

## 5. Open questions (need a decision)

1. Approve the privacy-forward defaults in §2 (they reduce training data available to improve cleanup quality).
2. ASR provider for MVP (evaluate 2–3 on latency, accuracy, keyword boosting, data terms).
3. Is meeting capture in scope for v1.0 or a separate later product? (Recommended: later — P2.)
4. Final brand name and visual identity.
5. Data residency requirements (US-only at launch?).
