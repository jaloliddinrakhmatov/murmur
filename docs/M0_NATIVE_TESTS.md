# M0 Native Tests — Prototypes A, B, C

Measured 2026-10-15 on one machine. Every number here comes from a run in this environment; anything not run is marked **NOT TESTED** with the reason.

## Test environment

| Item                                    | Value                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Hardware                                | Apple M2, 8 GB RAM (heavy swapping observed during the session)                                   |
| OS                                      | macOS 27.0.1 (build 26A434), arm64                                                                |
| Displays                                | Built-in Retina 1710×1107 pt @2×; external 1920×1080 @1×, placed above the built-in (negative y)  |
| Toolchains                              | Rust 1.99.0 (installed via rustup for M0), Node 24.12.0, Electron 44.5.1 (Node 24.21.0, N-API 10) |
| Crates                                  | napi 3, napi-derive 3, objc2 0.6, objc2-app-kit 0.3, core-foundation 0.10                         |
| Host process                            | Claude Code inside Cursor (`com.todesktop.230313mzl4w4u92`)                                       |
| **TCC permissions of the test process** | Accessibility **no**, Input Monitoring **no**, Post Event **no**                                  |

The missing permissions are the most important constraint on these results. We deliberately did not grant broad permissions to the editor/terminal hosting the agent. As a result:

- live key **delivery** (pressing a physical key) was not exercised;
- event-tap listening, Accessibility element inspection/insertion, and synthetic Cmd+V were only tested on their **"permission missing"** paths.

A manual runbook for those paths is at the end.

## Summary

| Prototype     | Verdict                            | Why                                                                                                                                                                                                                                                             |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Keyboard  | **PARTIAL**                        | Registration, unregistration, conflict detection, validation and the hold-to-talk state machine are tested (23 Rust + 10 Node tests). Physical key-down/key-up delivery is **not tested** (needs a human key press; the event tap also needs Input Monitoring). |
| B — Overlay   | **PASS** (one sub-item NOT TESTED) | 10/11 automated checks pass, including two negative controls. Click-through with a real pointer is not tested.                                                                                                                                                  |
| C — Insertion | **PARTIAL**                        | Clipboard guard, transient markers, layout-aware paste key, frontmost-app detection and secure-input rejection are tested live. AX insertion, AX secure-field detection and synthetic paste are **not tested** (need Accessibility / Post Event permission).    |

## Prototype A — Native keyboard integration (`native`)

### Design

- **`murmur-core`** (pure Rust, no FFI): shortcut parser/validator, conflict finder, hold-to-talk state machine.
- **`murmur-native`** (napi-rs addon) offers two backends, selected by `validate()`:
  - **Carbon `RegisterEventHotKey`**: no TCC permission; delivers press **and** release; modifier+key combos only.
  - **Listen-only `CGEventTap`**: needs **Input Monitoring only, not Accessibility**; used for modifier-only shortcuts (Right Option, Fn, Ctrl+Opt). It never prompts unless the caller passes `requestPermission: true`.

  Least privilege by default: a user who picks a modifier+key shortcut grants nothing for hotkeys.

### Results

| Test                                                                                                                                                                                                         | Result                                                                                    | Evidence                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Shortcut parsing, aliases, display normalization                                                                                                                                                             | PASS                                                                                      | `cargo test` (murmur-core)                                 |
| Validation: needs-modifier, Shift-only, Escape reserved for cancel, max 3 keys, sided-modifier alone, system-reserved list (Cmd+Space, Ctrl+Space, Cmd+Tab, screenshots, Mission Control…)                   | PASS                                                                                      | Rust + Node tests                                          |
| Backend selection (Carbon vs event tap)                                                                                                                                                                      | PASS                                                                                      | Rust + Node tests                                          |
| Conflict finder: duplicates, hold-prefix (e.g. `Ctrl+Opt` inside `Ctrl+Opt+Space`)                                                                                                                           | PASS                                                                                      | Rust + Node tests                                          |
| Hold-to-talk state machine: hold, tap (<300 ms) cancel, double-tap → hands-free, toggle stop, triple-tap cancel, chord cancel, Esc, key-repeat ignore, 19-min warn / 20-min stop, swallow release after stop | PASS                                                                                      | 13 Rust tests + Node wrapper test                          |
| Carbon register / unregister / re-register without any permission                                                                                                                                            | PASS                                                                                      | Node test; p50 **0.054 ms** per register+unregister (n=50) |
| Same combo twice in one process                                                                                                                                                                              | PASS (rejected, `-9878`)                                                                  | Node test                                                  |
| Cross-process conflicts (two Node processes)                                                                                                                                                                 | PASS (behavior recorded below)                                                            | Node tests                                                 |
| Carbon vs system shortcuts                                                                                                                                                                                   | Measured: **`Cmd+Space` accepted (status 0)**                                             | Node test                                                  |
| `Opt+K` / `Opt+Shift+K` via Carbon                                                                                                                                                                           | Measured: registration **accepted**; delivery **NOT TESTED**                              | probe                                                      |
| Event tap without Input Monitoring                                                                                                                                                                           | PASS: returns `input-monitoring-not-granted`, no prompt shown, permission state unchanged | Node test                                                  |
| Event tap start/stop with permission                                                                                                                                                                         | **NOT TESTED** (skipped: permission not granted)                                          | —                                                          |
| Addon loads and registers inside Electron 44                                                                                                                                                                 | PASS                                                                                      | overlay self-test                                          |
| Physical key-down / key-up delivery, Carbon handler → JS latency                                                                                                                                             | **NOT TESTED** (no human key press in this session)                                       | `npm start` in overlay prints it                           |

**Cross-process Carbon conflict matrix (measured):**

| Existing holder | New registration | OSStatus             |
| --------------- | ---------------- | -------------------- |
| exclusive       | exclusive        | **-9878** (rejected) |
| exclusive       | non-exclusive    | 0 (accepted)         |
| non-exclusive   | exclusive        | 0 (accepted)         |
| non-exclusive   | non-exclusive    | 0 (accepted)         |

**Implication:** macOS cannot tell us that another app already uses a shortcut unless both sides registered exclusively, and Carbon happily accepts system shortcuts such as Spotlight's `Cmd+Space`. Conflict prevention must come from Murmur's own reserved list plus user testing. We should always register exclusively, so that at least other exclusive registrants are detected.

### Platform limitations (A)

1. Carbon hotkeys are dispatched by the AppKit main event loop. They work in Electron's main process but **not in a plain Node process**. This was observed: registration succeeds in Node, but events can only arrive where a run loop runs.
2. Carbon cannot express modifier-only shortcuts or Fn. Those need the event tap, and therefore Input Monitoring.
3. macOS 15+ reportedly stops delivering Option/Option+Shift-only Carbon hotkeys. On macOS 27 registration still succeeds, so the restriction (if present) applies at delivery. Until verified, these combos are routed to the event tap.
4. **Secure Event Input** (password fields, some terminals, 1Password) suspends key delivery to event taps. `permissionStatus().secureEventInput` exposes it so the UI can explain why the hotkey seems dead.
5. A napi threadsafe callback keeps Node's event loop alive. `unregisterHotkey` / `stopKeyTap` must be called on shutdown (observed: a probe that forgot to unregister never exited).
6. Listen-only taps cannot swallow the key, so the shortcut also reaches the focused app. Suppressing it would require Accessibility; that is not proposed.

## Prototype B — Floating overlay (`prototypes/overlay`)

### Design

The Capsule is a `BrowserWindow` configured as follows:

- non-activating `type: "panel"`, `focusable: false`;
- transparent, frameless, shadowless;
- `alwaysOnTop` at the `screen-saver` level and visible on all Spaces and full-screen apps;
- click-through when idle (`setIgnoreMouseEvents(true, {forward: true})`, toggled by hover);
- sandboxed renderer, `contextIsolation`, CSP, navigation and new windows blocked.

It is shown only with `showInactive()`. Its visual design (ink pill, ember level bars) is original.

### Results (`npm run selftest` → `prototypes/overlay/results/overlay-selftest.json`)

| Check                                                                                                                                          | Result             | Measured                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Window config (always-on-top, not focusable, all workspaces)                                                                                   | PASS               | `ready-to-show` cold **644 ms**                                                                                                              |
| Transparent background                                                                                                                         | PASS               | captured pixel alpha: corner **0**, pill centre **250**                                                                                      |
| State change → painted (two `requestAnimationFrame`s)                                                                                          | PASS               | p50 **33.3 ms**, p95 **34.2 ms**, max 34.4 ms (n=60). That is about two 60 Hz frames, by construction of the measurement. Target was ≤50 ms. |
| Positioning on both displays (mixed 2×/1×, external above with negative y)                                                                     | PASS               | Capsule centred above the Dock inside each display's work area; `getDisplayMatching` resolves the right display                              |
| No focus steal — editor window in the same app; 30 cycles of hide/`showInactive`/`moveTop`/state change, plus a synthetic click on the capsule | PASS               | 0 violations. Editor stayed key, `activeElement` and caret position unchanged.                                                               |
| **Negative control:** a focusable window _does_ steal focus                                                                                    | PASS               | Editor lost focus, control gained it, so the detector is not blind                                                                           |
| No focus steal — external app (TextEdit); 30 cycles; frontmost checked via LaunchServices `lsappinfo`                                          | PASS               | 0 violations                                                                                                                                 |
| **Negative control:** an external focusable window takes frontmost                                                                             | PASS               | Frontmost became `com.github.Electron`                                                                                                       |
| Content protection (exclude from capture) configurable                                                                                         | PASS (config only) | Exclusion from a real screen share **not observed**                                                                                          |
| Click-through with a real pointer                                                                                                              | **NOT TESTED**     | No getter exists, and synthesizing a pointer needs Accessibility                                                                             |
| Native addon inside Electron                                                                                                                   | PASS               | N-API 10, Carbon registration ok                                                                                                             |

### Platform limitations and caveats (B)

- **`ELECTRON_RUN_AS_NODE=1` is inherited from VS Code/Cursor terminals** and makes `electron .` run as plain Node (`require("electron")` returns a path). The npm scripts unset it.
- The synthetic click uses `webContents.sendInputEvent`, which does not go through the window server's activation logic. A real mouse click on a `focusable:false` panel is **not tested**.
- `lsappinfo` output on macOS 27 uses `bundleID="…"`; older parsers expecting `"CFBundleIdentifier"` fail silently (this bit our first run).
- Full-screen-app and Spaces behavior, Stage Manager, and the Dock on the left or right were **not tested**.

## Prototype C — Text insertion (`native`, `insertText`)

### Strategy chain as built

1. If **Secure Event Input** is on (the only password signal available without Accessibility): **reject** and copy nothing.
2. If Accessibility is available: inspect the focused element. If its role/subrole is `AXSecureTextField`: **reject**.
3. **AX direct insert** (`AXSelectedText`), accepted only if `AXValue` read-back shows the text:
   - if the write succeeded but can't be verified, stop and report "unverifiable" rather than paste a second copy;
   - if the value is provably unchanged, fall through.
4. **Clipboard + Cmd+V**:
   - snapshot all clipboard items and types;
   - write the text with `org.nspasteboard.TransientType`, `ConcealedType` and `AutoGeneratedType` markers;
   - wait until the user releases their modifier keys;
   - post Cmd+V using the **layout-resolved keycode**;
   - the caller restores the snapshot later, **only if `changeCount` is unchanged**.
5. Otherwise, **clipboard-only**: the text is left on the clipboard for a manual paste.

### Results (`npm test`, `npm run measure` → `native/results/native-measurements.json`)

| Test                                                                                                  | Result                              | Measured                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clipboard write with transient/concealed/auto-generated markers (Unicode incl. Cyrillic and Uzbek ‘)  | PASS                                | write p50 **0.39 ms**, p95 4.6 ms                                                                                                                                                                                                                                                                  |
| Restore previous clipboard when unchanged                                                             | PASS                                | snapshot+write+restore cycle p50 **0.76 ms**, p95 0.84 ms                                                                                                                                                                                                                                          |
| **Never overwrite newer clipboard content** (user copies during the restore window)                   | PASS                                | restore refused with `clipboard-changed-since-write`; user content kept                                                                                                                                                                                                                            |
| Unknown/reused snapshot id refused                                                                    | PASS                                | —                                                                                                                                                                                                                                                                                                  |
| User's own clipboard restored after the whole suite                                                   | PASS                                | `userClipboardRestored: true`                                                                                                                                                                                                                                                                      |
| Layout-aware paste keycode, all **264** installed layouts                                             | PASS                                | US/ABC/British/French/German/Russian/Ukrainian/Kazakh/Uzbek-Cyrillic/Colemak → 9. **Dvorak → 47** (ANSI-V types "k"). **Turkish and Turkish-Standard (F-layout) → 8** (ANSI-V types "c"). Dvorak-QWERTY⌘ → 9. **Turkmen** has no Latin "v" with ⌘ → falls back to 9 (untested whether apps paste). |
| **Secure-input rejection** (Secure Event Input enabled via the same Carbon API a password field uses) | PASS                                | `strategy: rejected`, reason `secure-event-input`, clipboard untouched                                                                                                                                                                                                                             |
| Without Accessibility: focused element reported as `accessibility-not-trusted`                        | PASS                                | `focusedElement` p50 0.07 ms                                                                                                                                                                                                                                                                       |
| Without AX/Post Event: falls back to clipboard-only and says why                                      | PASS                                | chain p50 **10.3 ms** (n=30)                                                                                                                                                                                                                                                                       |
| Frontmost app detection                                                                               | **FAIL → fixed → PASS in Electron** | See below                                                                                                                                                                                                                                                                                          |
| AX focused-element role/subrole, `AXSecureTextField` rejection                                        | **NOT TESTED**                      | needs Accessibility                                                                                                                                                                                                                                                                                |
| AX direct insertion + read-back verification                                                          | **NOT TESTED**                      | needs Accessibility                                                                                                                                                                                                                                                                                |
| Synthetic Cmd+V paste into real apps; restore timing per app                                          | **NOT TESTED**                      | needs Accessibility (post events)                                                                                                                                                                                                                                                                  |
| Insertion into TextEdit, Safari, Chrome, Slack, VS Code, Terminal, etc.                               | **NOT TESTED**                      | as above. Runbook: `npm run manual:insert`                                                                                                                                                                                                                                                         |

**Frontmost-app finding (measured).** Three methods were compared while TextEdit was launched and made frontmost:

| Method                                        | Plain Node process                                       | Electron main process                                          |
| --------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| LaunchServices (`lsappinfo front`)            | correct                                                  | correct                                                        |
| `NSWorkspace.frontmostApplication`            | **stale**: stuck on the host app (Cursor) the whole time | **correct** (TextEdit, then Electron after the control window) |
| Topmost layer-0 window owner (`CGWindowList`) | **wrong** (Chrome)                                       | **wrong** (Electron)                                           |

The first implementation used the window-list heuristic and was wrong. It now uses `NSWorkspace`, which is correct inside Electron's run loop, which is where Murmur calls it. The heuristic is kept only as `frontmostAppByWindowList` for comparison.

### Platform limitations (C)

- **Secure Event Input detects native password fields only.** Whether Chromium/Electron web password inputs turn it on was **not verified**. Without Accessibility there is no other password signal, so Accessibility is effectively required for a safe "never insert into password fields" guarantee in browsers.
- The AX path is unverified. Electron/Chromium apps are known to expose limited AX trees unless assistive mode is on; this needs the app matrix in M3.
- Restoring the clipboard is lossy for some types per Apple's API (files and promises are snapshotted as raw data only). This was **not tested** with file/image clipboard contents.
- Synthetic Cmd+V while the user still holds the hotkey modifiers would become e.g. Ctrl+Opt+Cmd+V. The chain waits up to 600 ms for release (untested live).

## Untested macOS-specific behavior (checklist for the manual session)

1. Physical key-down/up delivery for Carbon hotkeys, and the handler→JS latency.
2. Event tap with Input Monitoring: Right Option and Fn hold-to-talk, chord cancel, Secure Input interruption, tap re-enable after `kCGEventTapDisabledByTimeout`.
3. Whether Option-only Carbon hotkeys fire on macOS 27.
4. Which app receives an exclusive vs non-exclusive duplicate Carbon hotkey.
5. AX focused element and `AXSecureTextField` detection in Safari, Chrome, Electron apps, Terminal.
6. AX insertion + verification, and synthetic Cmd+V, in the app matrix.
7. Clipboard restore timing vs slow pasters (Office, remote desktop).
8. Real-pointer click-through and clicking the capsule without activation.
9. Full-screen apps, Spaces, Stage Manager, Dock left/right/auto-hide.
10. Content protection during an actual screen share.
11. TCC grant survival across rebuilds (ad-hoc signatures change on every build).

## Manual runbook (≈10 minutes, least privilege)

Grant permissions to **Terminal.app** (not to Cursor/VS Code), run, then revoke.

```bash
source ~/.cargo/env
cd native && npm run build && npm test

# 1. Event-tap hotkeys: grant Input Monitoring only to Terminal
npm run manual:hotkeys          # hold / tap / double-tap Right Option; press Esc; Right Option+K

# 2. Insertion: grant Accessibility to Terminal (temporarily)
OBSERVED="ok" npm run manual:insert -- "Murmur test ✓"   # focus each target app within 5 s
# results append to native/results/manual-insert.jsonl

# 3. Overlay + Carbon hold-to-talk (no permission needed)
cd ../overlay && npm start      # hold Ctrl+Opt+Space; watch the capsule; type in the editor window
npm run selftest
```
