# Murmur release checklist

Status as of 2026-10-17 (Stage 8).

**Status values**

- **PASS:** verified.
- **FAIL:** verified broken.
- **PENDING:** not yet verified; needs you, hardware or authorisation.
- **BLOCKED:** can't be verified in this environment.

**Where a result comes from**

- _(hw)_: run on this Mac's real hardware.
- _(sim)_: automated, with fakes at the edges.
- _(pkg)_: run against the packaged app.

## Build and packaging

| Item                                                                                     | Status                                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Type-check, formatting, all unit tests                                                   | PASS                                                                                                        |
| Packaged app renders every Home and Settings screen (capture, throwaway profile) _(pkg)_ | PASS                                                                                                        |
| Electron smoke test, development build _(hw)_                                            | PASS (your run: 144 checks, 0 failed, 0 not tested, including no focus steal vs TextEdit)                   |
| Electron smoke test, packaged app                                                        | BLOCKED (Keychain prompt on re-signed ad-hoc builds; run on the Developer ID build)                         |
| Packaging configuration: name "Murmur", bundle ID `app.murmur.desktop`, icon, category   | PASS _(pkg)_ (bundle ID and icon are placeholders to confirm)                                               |
| `NSMicrophoneUsageDescription` and the audio-input entitlement                           | PASS _(pkg)_ (text rewritten in Stage 9D-2 for meeting recording; re-check in the next package)             |
| `NSAudioCaptureUsageDescription` and real system-audio capture (Notetaker, Stage 9D-2)   | PENDING (tap starts in the dev build; real capture to be checked by ear)     |
| Native addon unpacked and loading in the packaged app                                    | PASS _(pkg)_                                                                                                |
| Electron security fuses (RunAsNode off, NODE_OPTIONS off, asar integrity, asar-only)     | PASS _(pkg)_                                                                                                |
| Ad-hoc signature valid (`codesign --verify --deep --strict`)                             | PASS _(pkg)_ (re-verified 2026-10-19 by `npm run release`: also hardened runtime, arm64)                    |
| Release pipeline: DMG + ZIP arm64, versioned names, ad-hoc dry run, static verification  | PASS _(pkg)_ (2026-10-19, 17 pass / 0 fail / 3 expected ad-hoc warnings; `npm run release -w apps/desktop`) |
| Info.plist: bundle ID, version, microphone and audio-capture usage text re-checked       | PASS _(pkg)_ (2026-10-19)                                                                                   |
| Native addon unpacked and ad-hoc signed; fuses re-read from the packaged app             | PASS _(pkg)_ (2026-10-19)                                                                                   |
| Developer ID signing                                                                     | PENDING (pipeline ready: set `CSC_NAME` or `CSC_LINK`, run `npm run release`; needs your certificate)       |
| Notarisation and stapling (app and DMG)                                                  | PENDING (pipeline ready; needs Apple credentials, see `npm run release -- --help`)                          |
| Gatekeeper launch of a downloaded build                                                  | PENDING                                                                                                     |
| Build output outside iCloud-synced folders (codesign fails inside `~/Desktop` here)      | PASS (documented)                                                                                           |
| Final app icon and bundle ID approved                                                    | PENDING (decision)                                                                                          |

## macOS integration (installed, signed app, launched from Finder)

| Item                                                             | Status                                         |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| Microphone permission prompt shows "Murmur" and the usage text   | PENDING                                        |
| Accessibility (paste) permission flow                            | PENDING                                        |
| Launch at login: enable, log out and in, requires-approval path  | PENDING                                        |
| Dock icon preference across a restart                            | PENDING (passed in the dev build _(hw)_)       |
| Menu-bar item and its menu                                       | PENDING (works in the dev build)               |
| Settings and History persist across restarts in the real profile | PENDING (passed in throwaway profiles _(sim)_) |
| Clean quit (no leftover processes)                               | PASS _(pkg)_ (capture run exited 0)            |

## Dictation

| Item                                                                               | Status                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hold, speak, release: inserted exactly once _(sim)_                                | PASS                                                                                                                                                              |
| Clipboard fallback reported honestly _(sim)_                                       | PASS                                                                                                                                                              |
| Cancel while opening, recording, transcribing or cleaning up _(sim)_               | PASS                                                                                                                                                              |
| Failure outcomes (mic, permission, auth, network, timeout, empty, History) _(sim)_ | PASS                                                                                                                                                              |
| "Starting mic…" until audio arrives; never "recording" early _(sim, hw)_           | PASS                                                                                                                                                              |
| Release before the microphone is ready: reported, never silent _(sim, hw)_         | PASS                                                                                                                                                              |
| 60-sequence randomised stress test; no leaks or double inserts _(sim)_             | PASS                                                                                                                                                              |
| Real microphone, 20+ open/close cycles, cancels _(hw)_                             | PASS                                                                                                                                                              |
| Live transcription: OpenAI                                                         | BLOCKED (your OpenAI account has no credits: HTTP 429 insufficient_quota). Murmur's failure handling worked; the message is now "No credits left on this API key" |
| Live transcription with your key (Groq)                                            | PASS _(hw, you, 2026-10-17)_                                                                                                                                      |
| Live transcription: Deepgram (English)                                             | PASS _(hw, you, 2026-10-17)_. Auto-detect and other languages: PENDING                                                                                            |
| whisper.cpp local                                                                  | PENDING (no local server configured)                                                                                                                              |
| AI cleanup against a live model (`npm run eval -w packages/refine`)                | PENDING (authorisation; AI stays off by default)                                                                                                                  |

## Insertion (real apps; needs you)

| Item                                                | Status                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- |
| TextEdit (rich text document)                       | PASS _(hw, you, 2026-10-17)_: inserted once, History updated  |
| Notes                                               | PENDING                                                       |
| Browser text field                                  | PASS _(hw, you, 2026-10-17)_                                  |
| Electron app: Telegram                              | PASS _(hw, you, 2026-10-17)_                                  |
| Code editor (VS Code), Slack                        | PENDING                                                       |
| Password field refused                              | PASS _(hw, you, 2026-10-17)_: "Password field — not inserted" |
| App switched during transcription gives a copy      | PENDING _(hw)_; PASS _(sim)_                                  |
| Clipboard restored, never overwriting newer content | PASS _(hw, smoke)_                                            |

## Audio hardware

| Item                                                                 | Status                                          |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Built-in microphone _(hw)_                                           | PASS                                            |
| Device selection and fallback with built-in + virtual devices _(hw)_ | PASS                                            |
| USB microphone                                                       | BLOCKED (none attached)                         |
| Bluetooth microphone                                                 | BLOCKED (headsets paired, none connected)       |
| Unplug and reconnect                                                 | BLOCKED (no removable microphone); PASS _(sim)_ |
| Default input change while running                                   | PENDING                                         |
| Permission revoked and granted while running                         | PENDING                                         |
| Sleep/wake                                                           | PENDING                                         |
| Preview, then dictation, shares one stream _(hw)_                    | PASS                                            |

## Security and privacy

| Item                                                                                    | Status                                                                     |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| No Critical or High findings (independent review)                                       | PASS                                                                       |
| Microphone permission limited to the audio window _(hw)_                                | PASS                                                                       |
| Hub IPC only from the Hub page; inputs validated                                        | PASS                                                                       |
| Local speech server limited to loopback addresses                                       | PASS                                                                       |
| Password-field dictations keep no text or audio _(sim)_                                 | PASS                                                                       |
| Cleared History overwritten (secure_delete, WAL truncate), orphan audio removed _(sim)_ | PASS                                                                       |
| No keys or transcripts in logs; key redaction includes Deepgram and Bearer _(sim)_      | PASS                                                                       |
| Development `.env` overrides ignored in installed builds                                | PASS (code)                                                                |
| `npm audit --omit=dev`, `cargo audit`                                                   | npm: 0 vulnerabilities (2026-10-19). `cargo audit`: not installed, PENDING |
| Private screenshots and derived output git-ignored                                      | PASS                                                                       |

## Accessibility

| Item                                                      | Status  |
| --------------------------------------------------------- | ------- |
| axe-core, all screens and dialogs, light and dark _(sim)_ | PASS    |
| Keyboard and focus behaviour (smoke checks) _(sim)_       | PASS    |
| VoiceOver pass                                            | PENDING |

## Repository

| Item                                            | Status                               |
| ----------------------------------------------- | ------------------------------------ |
| No secrets in the working tree (scan)           | PASS (only fake test keys)           |
| Commit plan prepared, screenshot volume trimmed | PENDING (your approval; report § 18) |
| Nothing committed or pushed                     | PASS                                 |

## Keychain

| Item                                                                                         | Status                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start-up doesn't wait on the Keychain (unanswered dialog: composed in 0.76 s)                | PASS (real app, simulated Keychain)                                                                                                                                                                         |
| One Keychain request at a time; no automatic re-asking after "no"                            | PASS _(sim)_                                                                                                                                                                                                |
| Keychain unavailable: nothing stored or read as plaintext; keys "locked", not missing        | PASS _(sim)_                                                                                                                                                                                                |
| Recording key never created or replaced while locked or unreadable; recordings never deleted | PASS _(sim)_                                                                                                                                                                                                |
| Retry after recovery reads the same key and data                                             | PASS _(sim)_                                                                                                                                                                                                |
| Settings → Data and Privacy shows the true state, with Try again                             | PASS (unit + a11y + screenshot)                                                                                                                                                                             |
| Automated runs never touch the real Keychain (isolated test keychain)                        | PASS                                                                                                                                                                                                        |
| Async API reads data written by the old synchronous API                                      | PASS (compatible, 1/1). Keys written before 2026-10-17 01:53 UTC: 0/198 readable (the item's secret changed)                                                                                                |
| Your dev profile's saved API key and recording key readable                                  | FAIL (confirmed). New API key saved and working; "Start a new recording key…" (Settings → Data and Privacy, confirmed action, old key and recordings kept aside) is built and tested; using it is your step |
| "Murmur Safe Storage" test item removed                                                      | PENDING (your approval)                                                                                                                                                                                     |
| Packaged smoke run on a stable (Developer ID) signature                                      | PENDING                                                                                                                                                                                                     |
