# Architecture — Murmur

Status: Proposed (2026-10-15). Stack requested: Next.js, Electron, NestJS, PostgreSQL, Prisma, Tailwind CSS, shadcn/ui, TypeScript. Nothing is implemented yet.

## 1. System overview

```
┌──────────────────────────── Desktop (Electron) ─────────────────────────────┐
│  Main process (TS)                                                          │
│   ├─ DictationController (state machine)                                    │
│   ├─ AudioService ──► hidden "audio" renderer (getUserMedia + AudioWorklet) │
│   ├─ SpeechClient (WebSocket to API)                                        │
│   ├─ PostProcessor (dictionary corrections, snippets) — shared package      │
│   ├─ LocalStore (SQLite: history, settings cache, sync queue)               │
│   └─ native addon  @murmur/native (Rust, napi-rs)                           │
│        ├─ hotkeys    (CGEventTap / WH_KEYBOARD_LL)                          │
│        ├─ insertion  (AX / UIA / clipboard / SendInput / CGEvent)           │
│        ├─ context    (focused app, URL host, text around cursor)            │
│        └─ permissions (TCC status, Secure Input, elevation)                 │
│  Renderers: Hub window (React + Tailwind + shadcn/ui), Capsule window        │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ HTTPS (REST) + WSS (speech)
┌───────────────▼──────────────── API (NestJS) ───────────────────────────────┐
│  auth · users · settings · dictionary · snippets · styles · usage/quota     │
│  billing (Stripe webhooks) · teams · privacy (export/delete) · app-catalog  │
│  speech gateway (WS) ─► ASR provider (streaming)                            │
│  cleanup service      ─► LLM provider                                       │
│  workers (BullMQ): exports, deletions, meeting processing, aggregates       │
└───────┬──────────────────────────┬───────────────────────┬──────────────────┘
        │ Prisma                   │                       │
   PostgreSQL                   Redis                 Object storage (S3)
                                (queues, rate limits,  (exports; meeting audio
                                 quota counters)        ≤7 days, P2)
┌──────────────────────────── Web (Next.js) ──────────────────────────────────┐
│  Marketing, pricing, download, auth pages, account & billing, team admin    │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2. Monorepo layout

pnpm workspaces + Turborepo.

```
apps/
  web/        Next.js (App Router) — marketing, auth, account, admin
  desktop/    Electron — main (TS), preload, renderers (React via Vite)
  api/        NestJS — REST + WebSocket gateway + workers entrypoint
packages/
  ui/         shadcn/ui components + Tailwind preset + design tokens (shared by web and desktop)
  db/         Prisma schema, migrations, generated client (API only)
  contracts/  zod schemas + inferred TS types for every API request/response and WS message
  text/       pure TS: dictionary matching, snippet expansion, punctuation rules, word counting
  config/     eslint, tsconfig, tailwind base
native/
  murmur-native/  Rust crate built with napi-rs → prebuilt .node per platform/arch
docs/
```

Rules: `packages/text` and `packages/contracts` are dependency-free and shared by API and desktop so post-processing is identical everywhere. `packages/db` is never imported by `desktop` or `web` client code.

### Why each piece (and the trade-off)

| Choice                          | Why                                                                                                                                                              | Trade-off / mitigation                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electron**                    | One TS codebase for Mac + Windows UI; mature auto-update, signing, crash reporting; shares React/shadcn with web.                                                | ~150 MB install, higher idle RAM than native/Tauri; _cannot_ do global key-up hooks, focus-safe overlays, or text insertion by itself → native addon is mandatory. Tauri would cut size but brings a second language for all app code and weaker Windows overlay tooling. |
| **Rust native addon (napi-rs)** | One language for both OS layers (`objc2`/`core-foundation` on macOS, `windows-rs` on Windows); memory-safe; prebuilt binaries avoid `node-gyp` on user machines. | Team needs Rust skills; macOS APIs are more ergonomic in Swift. Alternative: Swift + C# sidecar helpers over stdio — easier per-platform, but two extra languages and IPC latency (~1–3 ms, acceptable). Decision point at M1 spike.                                      |
| **NestJS**                      | Structured modules, DI, WebSocket gateways, guards for auth/quota, good fit for a team-sized API.                                                                | Heavier than Fastify alone; use the Fastify adapter for throughput.                                                                                                                                                                                                       |
| **PostgreSQL + Prisma**         | Relational data (users, teams, entitlements), strong migrations.                                                                                                 | Prisma is not used on the desktop (native engine binaries complicate Electron packaging); desktop uses SQLite via `better-sqlite3` with hand-written migrations. Hot paths (usage increments) use raw SQL.                                                                |
| **Next.js**                     | SSR/SSG marketing pages for SEO, React Server Components for account pages, shares `packages/ui`.                                                                | Keep it a thin client of the API; no business logic in route handlers beyond auth session handling.                                                                                                                                                                       |
| **Tailwind + shadcn/ui**        | Owned component source (not a dependency), consistent across web + desktop.                                                                                      | Must restyle to our original identity; don't ship default look.                                                                                                                                                                                                           |

## 3. Dictation sequence (happy path)

```
key-down ─► native hotkey event ─► DictationController: idle→listening
   ├─ Capsule shows "listening" (≤50 ms)
   ├─ AudioService starts capture (pre-roll ring buffer keeps last 300 ms)
   ├─ snapshot context (app id, URL host, text around cursor)        [async]
   └─ SpeechClient opens/reuses WS: {sessionId, lang, keywords[]}    [pre-warmed]
audio frames (20 ms, 16 kHz mono, Opus) ─► API gateway ─► ASR stream
key-up ─► controller: listening→processing; send end-of-audio
API: final ASR transcript ─► cleanup LLM (context, style, dictionary, protected snippet triggers)
   ├─ timeout 1.2 s ─► return raw transcript with flag "unformatted"
   └─ guardrails (length ratio, no answering, no new facts)
API ─► {rawText, cleanText, usage} ─► desktop
desktop: packages/text post-process (corrections, snippets, period rule)
desktop: native.insert(text, target=focusAtKeyUp) ─► strategy chain
desktop: write History row; controller: processing→inserted→idle
```

Latency budget (15 s utterance): ASR finalization 250 ms · LLM cleanup 450 ms (small fast model, e.g. Claude Haiku 5.5, streamed) · network 100 ms · insertion 50 ms → ~850 ms p50.

The **DictationController** is an explicit state machine (XState or a hand-rolled reducer) with states `idle, arming, listening, handsFree, stopping, processing, inserting, error` and guards for every illegal transition (e.g. key-down while `processing`). It is the most-tested unit in the app.

## 4. Global hotkeys

Electron `globalShortcut` only fires on press, cannot bind modifier-only keys (`fn`, `Right Option`, `Ctrl+Win`), and cannot swallow keys. Therefore:

- **macOS:** `CGEventTapCreate` on a dedicated thread with its own CFRunLoop, listening to `keyDown/keyUp/flagsChanged/otherMouseDown/Up`. Requires **Input Monitoring** (listen-only tap) or **Accessibility** (to suppress events). `fn` is detected via `kCGEventFlagMaskSecondaryFn` in `flagsChanged`; conflicts with the system Globe-key action, so we default to Right Option and offer fn as opt-in with instructions to set Globe to "Do Nothing". Detect Secure Event Input with `IsSecureEventInputEnabled()` and surface it.
- **Windows:** `SetWindowsHookEx(WH_KEYBOARD_LL)` + `WH_MOUSE_LL` on a thread with a message loop. Hook callbacks must return within ~300 ms or Windows silently removes the hook (`LowLevelHooksTimeout`) → callback only enqueues events; a watchdog re-installs the hook if events stop. `Ctrl+Win` must suppress the Start menu (inject a dummy key on Win release, a known technique).
- Stuck-key watchdog: if no key-up arrives within 10 s and the physical key state (`GetAsyncKeyState` / `CGEventSourceKeyState`) is up, synthesize release.

## 5. Native text insertion

This is the highest-risk area. No single technique works everywhere, so we use a **strategy chain** selected by target app and field capabilities, with an app-specific override table shipped from the server (`AppCatalog`).

### Techniques compared

| Technique                          | macOS API                                                                       | Windows API                                                                            | Pros                                                                                                                        | Cons                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Clipboard + synthetic paste** | `NSPasteboard` + `CGEventPost(Cmd+V)`                                           | `SetClipboardData` + `SendInput(Ctrl+V)`                                               | Works in almost every app incl. Electron/Chromium, Java, remote desktops; fast for long text; supports rich text (HTML/RTF) | Clobbers clipboard (must restore, lossy for files/images); clipboard managers record it; timing races (restore before target reads → wrong paste); paste shortcut varies (terminals: `Ctrl+Shift+V`/`Shift+Insert`); keycode depends on keyboard layout; blocked by Secure Input and by UIPI for elevated targets |
| **B. Accessibility direct set**    | `AXUIElementSetAttributeValue(kAXSelectedTextAttribute)` on the focused element | UI Automation `ValuePattern.SetValue` (replaces all text) or `TextPattern` (read-only) | No clipboard side effects; precise                                                                                          | macOS: many apps (Chromium, Electron, some Catalyst) report success but don't update, or break undo; Windows: `ValuePattern` replaces the whole value — unusable for insertion at cursor in most editors; requires verifying the result                                                                           |
| **C. Synthetic Unicode typing**    | `CGEventKeyboardSetUnicodeString` per chunk                                     | `SendInput` with `KEYEVENTF_UNICODE`                                                   | Layout-independent; no clipboard; works in terminals and remote sessions that block clipboard                               | Slow for long text (~5–20 ms per chunk); autocomplete/autocorrect in target can mangle text; IME interference; newlines become Enter (may send messages in chat apps!)                                                                                                                                            |
| **D. App-specific integration**    | AppleScript/JXA, browser extension, IDE extension                               | COM (Office), extension                                                                | Highest fidelity (e.g. VS Code API)                                                                                         | Per-app maintenance; out of MVP scope                                                                                                                                                                                                                                                                             |

### Recommended chain

```
pre-check: focused element is secure/password → abort (no copy, show message)
pre-check (Win): target process integrity level > ours → show "run as administrator" message, copy to clipboard
1. AppCatalog override for this app? → use it
2. text is short (≤ 64 chars), no newlines, target is terminal-like → C (typing)
3. macOS and element supports AX selected-text set and app is on AX-verified allowlist → B, then verify by re-reading value; on mismatch fall through
4. A (clipboard paste) with:
     - write plain + HTML representations
     - mark transient: macOS `org.nspasteboard.TransientType` + `ConcealedType`; Windows `ExcludeClipboardContentFromMonitorProcessing` and `CanIncludeInClipboardHistory=0`
     - resolve paste keycode from current layout (`UCKeyTranslate` / `VkKeyScanEx`)
     - wait for modifier keys to be physically released before posting paste
     - restore previous clipboard after changeCount settles + per-app delay (500 ms default; 3 s Office; 5 s remote desktop), only if clipboard still holds our content
5. On failure → leave text on clipboard, show "Copied — press ⌘V", keep in History
```

Insertion always targets the element focused **at key-up**; if focus moved to a different app during processing we still insert (matches user expectation of "where my cursor is now"), but if the focused element is not editable we fall back to step 5.

**Electron-specific notes:** the Capsule window must be `focusable: false`, `type: 'panel'` on macOS (non-activating `NSPanel`; verify `showInactive()` never activates the app), `alwaysOnTop: 'screen-saver'`, `setIgnoreMouseEvents(true, {forward: true})` when idle, and `setContentProtection(true)` when excluded from capture. Any focus steal breaks insertion, so this is covered by an automated test.

## 6. Context capture

Native module returns `{ appId, appName, windowTitle?, urlHost?, beforeCursor (≤500 chars), selection (≤2,000 chars), afterCursor (≤200 chars), isSecure, isTerminal, isEditable }`.

- macOS: `AXFocusedUIElement`, `kAXValueAttribute`, `kAXSelectedTextRangeAttribute`; browser URL via `AXDocument`/AXWebArea or app-specific AppleScript (requires Automation permission — P1, opt-in).
- Windows: UI Automation `FocusedElement`, `TextPattern.GetSelection`, `DocumentRange`; URL from browser address-bar element.
- Strictly time-boxed (≤ 80 ms) and run in parallel with recording; never blocks dictation.
- Never captured: secure fields, apps on a denylist (password managers, banking), our own windows.

## 7. Audio

- Capture in a hidden renderer using `getUserMedia` (device selection, echo cancellation off, noise suppression on) + `AudioWorklet` → 16 kHz mono PCM → Opus (WASM encoder) frames of 20 ms → main process → WS. Rationale: Chromium's audio stack handles device changes and permissions; avoids a second native audio path in MVP.
- Mic opening latency: keep the stream "warm" for 30 s after use is **not** allowed (privacy indicator stays on). Instead accept ~80–150 ms open latency and cover it with immediate visual feedback; evaluate native capture (AVAudioEngine/WASAPI) if p95 open latency > 200 ms.
- Local copy of every dictation's audio written to an encrypted file until success (+7 days if storage mode is `keep`) so failures are always retryable.
- Meetings (P2): system audio via Core Audio process taps (macOS 14.4+), ScreenCaptureKit audio (13.x), WASAPI loopback (Windows) — in the native addon.

## 8. Backend modules (NestJS)

| Module                                         | Responsibility                                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth`                                         | OIDC (Google, Microsoft, Apple), email magic-link/code; desktop PKCE code exchange; short-lived access JWT (15 min) + rotating refresh token (stored hashed) |
| `speech`                                       | WS gateway; authenticates, checks quota, proxies audio to ASR provider, enforces 20-min cap, returns partials/final                                          |
| `cleanup`                                      | Prompt assembly, LLM call with timeout, guardrails, raw fallback; versioned prompts                                                                          |
| `dictionary`, `snippets`, `styles`, `settings` | CRUD + delta sync (`updatedAt` cursor + tombstones)                                                                                                          |
| `usage`                                        | Word counting (shared `packages/text`), Redis counters flushed to `UsageDaily`; weekly quota                                                                 |
| `billing`                                      | Stripe Checkout/Portal, webhook handler (idempotent by event id), entitlements                                                                               |
| `teams`                                        | Orgs, memberships, invites, shared scopes, policies                                                                                                          |
| `privacy`                                      | Export and deletion jobs, privacy settings audit log                                                                                                         |
| `app-catalog`                                  | App → category + insertion override table served to clients                                                                                                  |
| `meetings` (P2)                                | Upload sessions, transcription and summary jobs                                                                                                              |

Providers sit behind interfaces (`SpeechProvider`, `CleanupProvider`) so we can switch vendors or add on-device ASR without touching callers. Provider contracts must guarantee zero data retention and no training.

## 9. Data model (Prisma sketch)

Condensed for review: one-line models use `;` as separators and enums are omitted, so this is not valid Prisma syntax as written. The `database-engineer` agent turns it into the real schema in M1.

```prisma
model User {
  id              String   @id @default(cuid())
  email           String   @unique
  name            String?
  createdAt       DateTime @default(now())
  onboardedAt     DateTime?
  privacy         PrivacySettings?
  settings        UserSettings?
  memberships     Membership[]
  identities      Identity[]
  devices         Device[]
  deletedAt       DateTime?
}

model Identity        { id String @id @default(cuid()); userId String; provider String; subject String; @@unique([provider, subject]) }
model Device          { id String @id @default(cuid()); userId String; platform String; appVersion String; lastSeenAt DateTime }
model RefreshToken    { id String @id @default(cuid()); userId String; deviceId String; tokenHash String @unique; expiresAt DateTime; revokedAt DateTime? }

model PrivacySettings {
  userId           String  @id
  trainingOptIn    Boolean @default(false)
  cloudHistory     Boolean @default(false)
  contextLevel     ContextLevel @default(NARROW) // OFF | NARROW | FULL
  updatedAt        DateTime @updatedAt
}

model UserSettings    { userId String @id; languages String[]; cleanupLevel CleanupLevel @default(LIGHT); data Json; updatedAt DateTime @updatedAt }

model Organization    { id String @id @default(cuid()); name String; policy Json; subscription Subscription? }
model Membership      { userId String; orgId String; role Role; @@id([userId, orgId]) }

model DictionaryEntry {
  id         String    @id @default(cuid())
  ownerType  OwnerType // USER | ORG
  ownerId    String
  phrase     String    @db.VarChar(60)
  phraseKey  String    // lower(trim(phrase)) for uniqueness
  misheardAs String?   @db.VarChar(60)
  source     EntrySource
  usageCount Int       @default(0)
  updatedAt  DateTime  @updatedAt
  deletedAt  DateTime?
  @@unique([ownerType, ownerId, phraseKey])
  @@index([ownerType, ownerId, updatedAt])
}

model Snippet {
  id         String   @id @default(cuid())
  ownerType  OwnerType
  ownerId    String
  trigger    String   @db.VarChar(60)
  triggerKey String
  expansion  String   @db.VarChar(4000) // markdown subset
  updatedAt  DateTime @updatedAt
  deletedAt  DateTime?
  @@unique([ownerType, ownerId, triggerKey])
}

model StylePreference { userId String; category AppCategory; tone Tone; @@id([userId, category]) }
model AppCatalogEntry { id String @id; matcher String; platform String; category AppCategory; insertion Json? }

model UsageDaily      { userId String; day DateTime @db.Date; words Int; dictations Int; @@id([userId, day]) }
model Subscription    { id String @id; orgId String? @unique; userId String? @unique; plan Plan; status String; currentPeriodEnd DateTime; stripeCustomerId String }
model StripeEvent     { id String @id; processedAt DateTime }

model CloudDictation  { id String @id; userId String; createdAt DateTime; text String; rawText String; appCategory AppCategory?; wordCount Int; @@index([userId, createdAt]) } // only when cloudHistory = true; no audio
model PrivacyAuditLog { id String @id @default(cuid()); userId String; field String; oldValue String; newValue String; actorId String; at DateTime @default(now()) }
model DataJob         { id String @id @default(cuid()); userId String; kind String; status String; resultKey String?; expiresAt DateTime? }
```

Desktop SQLite mirrors `dictionary_entries`, `snippets`, `settings` (sync cache with `dirty` flag) and owns `dictations` (local history) and `sync_queue`.

## 10. Sync

- Server-authoritative, per-entity last-write-wins using server `updatedAt`; client sends `baseUpdatedAt` and the server returns `409` with the current row on conflict, which the client accepts (shows toast).
- Pull: `GET /sync?since=<cursor>` returns changed entries + tombstones across dictionary, snippets, styles, settings.
- Push: offline edits queue in `sync_queue`, retried with backoff.

## 11. Security and privacy architecture

- Electron: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP, typed `contextBridge` API only, validate every IPC payload with zod, block `window.open`/navigation, `@electron/fuses` (disable RunAsNode, enable cookie encryption, ASAR integrity).
- Tokens in macOS Keychain / Windows Credential Manager (via native addon or `safeStorage`).
- Local SQLite and audio encrypted with a key held in `safeStorage`.
- Code signing + notarization (Apple), EV/Azure Trusted Signing (Windows); auto-update via signed feed (`electron-updater` with signature verification).
- API: rate limits per user and IP, quota guard, audit log for privacy and admin actions, PII-free logs (no transcript text in logs, ever), request IDs.
- Speech data path: audio streamed to ASR, never written to disk server-side for dictation; transcripts kept in memory only unless `cloudHistory` is on.
- Fail closed: if the client can't fetch the org policy, use the most restrictive cached policy.

## 12. Observability

- Client: Sentry (crash + performance), metadata-only telemetry (stage latencies, insertion strategy + success, app id) — opt-out available.
- API: OpenTelemetry traces across gateway → ASR → LLM; dashboards for p50/p95 per stage; alert on raw-fallback rate > 5%.

## 13. Key risks (summary — detail in ROADMAP.md)

1. Insertion reliability across apps (mitigated by strategy chain + per-app catalog + automated app matrix).
2. Latency dominated by third-party ASR/LLM (provider bake-off, streaming, regional endpoints).
3. macOS permission UX and TCC invalidation on updates (stable signing identity, re-check on launch).
4. Electron overlay focus-steal regressions across Electron upgrades (pinned version + test).
5. LLM cleanup altering meaning (guardrails, raw fallback, undo AI edit, eval suite).
6. Unit economics: ASR + LLM cost per word vs free tier (track cost/word from day one).
