# M2 Verification Report

Date: 2026-10-15. Machine: Apple M2, 8 GB, macOS 27.0.1, Electron 44.5.1 (Node 24.21), Rust 1.99. All results below were produced in this session. Items needing a human are listed under **Manual tests required** ([M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md)).

## Scope delivered

| Area                                        | Delivered                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Transcript pipeline** (`packages/refine`) | Dictionary corrections → cleanup → dictionary casing → snippet expansion, behind one `processTranscript()` used for live dictation and for retry.                                                                                                                                                                                                                                                                                                                  |
| **Cleanup modes**                           | `deterministic` (default, also the fallback), `ai` (opt-in), `off`.                                                                                                                                                                                                                                                                                                                                                                                                |
| **AI cleanup**                              | Providers: Groq, OpenAI (OpenAI-compatible chat API) and Anthropic Claude (official SDK, `claude-haiku-5-5` default with thinking disabled at low effort). Configurable timeout (default 4 s).                                                                                                                                                                                                                                                                     |
| **AI security**                             | Transcript wrapped in `<transcript>` tags and declared untrusted; system prompt forbids answering, following, translating or summarizing. Output guardrails reject empty output, length explosion, length collapse (one-word answers), novel content (answers, code, translations), **dropped or added negations**, and **changed numbers**; any rejection or timeout falls back to deterministic cleanup. The rejected AI output is stored in History for review. |
| **Dictionary**                              | Hub page: add, edit, delete, enable/disable, search (phrase and "often heard as"), duplicate detection (case-, space- and Unicode-normalized), import/export (JSON), usage counts. Applied after transcription (whole words, Unicode-aware, longest phrase first, single pass, never inside URLs/emails/paths) and sent to the speech provider as vocabulary hints (first 100, toggleable).                                                                        |
| **Snippets**                                | Hub page: create, edit, delete, enable/disable, search, live preview, conflict detection (duplicate trigger = error, dictionary clash = error, overlapping trigger / common word / self-referencing replacement = warning). Expanded once after cleanup: no recursion; longest trigger wins; a trigger spoken alone yields the replacement verbatim.                                                                                                               |
| **History**                                 | Search (raw and refined text, case-insensitive, LIKE wildcards escaped), grouping by day, copy, per-row delete (row + audio), retry, raw / refined / side-by-side comparison, rejected-AI-output disclosure, plain-language recovery status, cleanup provenance, JSON export of all local data, delete-all (rows + audio), history retention (rows and audio deleted together), audio retention (unchanged AES-256-GCM vault).                                     |
| **Settings**                                | Cleanup mode, AI provider/key/model/time limit with privacy notice, dictionary on/off and vocabulary hints, snippets on/off, history retention, audio retention, "what leaves this Mac" explanation. M1 `settings.json` files migrate automatically (`cleanup: "light"` → `{ mode: "deterministic" }`).                                                                                                                                                            |
| **Database**                                | SQLite schema v2: cleanup provenance columns on `dictations`, `dictionary_entries`, `snippets`. M1 databases migrate in place (tested with a genuine v1 file).                                                                                                                                                                                                                                                                                                     |

**AI cleanup is not enabled by default.** The default stays `deterministic`, as required, because no live cloud model has passed the evaluation suite yet (see Blockers).

## Automated results

| Suite                                                                                                                   | Tests   | Result                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `@murmur/text`: cleanup, dictionary, snippets, conflicts, Unicode                                                       | 21      | 21 passed                                                                                      |
| `@murmur/refine`: guardrails, injection suite, M0 recorded model outputs, pipeline, provider adapter                    | 7       | 7 passed                                                                                       |
| `@murmur/speech`: providers, WAV, config (M1, unchanged)                                                                | 6       | 6 passed                                                                                       |
| `@murmur/desktop`: M1 controller/stores/adapters + M2 repositories, migrations, settings migration, controller pipeline | 39      | 39 passed                                                                                      |
| `@murmur/native`: Rust core                                                                                             | 23      | 23 passed                                                                                      |
| `@murmur/native`: Node addon                                                                                            | 24      | 21 passed, 3 skipped (the "permission missing" variants; this machine now has the permissions) |
| **Total**                                                                                                               | **120** | **117 passed, 3 skipped, 0 failed**                                                            |
| Type-check, all 5 workspaces                                                                                            | —       | clean                                                                                          |
| Prettier                                                                                                                | —       | clean except 4 pre-existing `.claude/` files                                                   |

### Required test topics → where they are covered

| Topic                         | Tests                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meaning preservation          | `refine`: legitimate cleanups accepted; novel-content/length guardrails; pipeline falls back to deterministic text, which never removes words beyond fillers                                                         |
| Negation preservation         | `refine`: `negation-changed` on removed/flipped negation; `controller-m2`: dropped negation rejected end to end                                                                                                      |
| Self-correction               | `refine`: "at 2 actually 3" → "3" accepted, number guardrail exempts explicit corrections; deterministic mode keeps both words (documented)                                                                          |
| Dictionary substitutions      | `text/dictionary`: casing, misheard spellings, longest phrase, single pass, protected URLs/emails/paths; `controller-m2`; smoke                                                                                      |
| Unicode                       | `text/dictionary` (Cyrillic, Uzbek ‘, accents), `repos` (search and duplicates with O‘zbekiston)                                                                                                                     |
| Snippet conflicts             | `text/snippets` (all issue codes); `repos` (duplicate trigger rejected at the DB level); smoke                                                                                                                       |
| Recursive snippet prevention  | `text/snippets` ("ping" → "ping pong" expands once); `controller-m2`                                                                                                                                                 |
| History search                | `repos` (raw + refined, wildcards, Unicode); smoke                                                                                                                                                                   |
| History deletion              | `stores`, `repos`; smoke (single delete; retention purge deletes rows **and** audio)                                                                                                                                 |
| Audio recovery                | M1 controller tests (failure keeps audio, retry copies); `controller-m2` (retry uses the new pipeline); smoke (encrypted audio kept, retry)                                                                          |
| Provider timeout and fallback | `refine` (timeout, provider error); `controller-m2` (AI timeout → deterministic, still inserted, provenance recorded); smoke (AI mode without key → deterministic with `ai-fallback:not-ready`)                      |
| Prompt injection resistance   | `refine`: answers, code, translation, poem, pirate-speak rejected; **regression on the 39 recorded M0 outputs of the local models**: every executed instruction is caught except the documented silent-deletion case |

### Electron smoke test (`npm run smoke`)

**33 checks: 32 PASS, 0 FAIL, 1 NOT-TESTED** (re-run after the native fix below; `apps/desktop/results/smoke.json`).

- **M1 checks, all still passing:** Capsule configuration and paint latency; Carbon shortcut; Esc only while recording; insertion; cancel; provider failure with encrypted audio; retry; silence; tap; secure-field rejection; app-switch copy; clipboard guard; real microphone capture; Hub renders and buttons are styled.
- **New M2 checks:** dictionary duplicate detection; snippet conflict detection; dictionary + snippets applied end to end; usage counting; history search (raw and refined); export contents; retention purge deletes rows with their audio; single deletion; AI mode without a key falls back to deterministic and records why; Dictionary, Snippets and History pages render.
- **NOT-TESTED:** "no focus steal vs TextEdit". TextEdit was open with your documents, and the smoke test never touches an already-running TextEdit. This check passed in M1 and the Capsule code is unchanged.

## Bugs found during M2 and fixed

1. **Use-after-free in `stopKeyTap` (native, latent since M0).** The stop loop could call `CFRunLoopStop` after the tap thread had exited and its run loop was freed, which caused a pointer-authentication trap (SIGTRAP) on Apple Silicon. It was only reachable once Input Monitoring was granted, which happened on this machine between M1 and M2. Fix: retain the run loop until the thread is joined. Regression test: 50 rapid start/stop cycles; 10/10 clean runs of the file.
2. **Native build overwrote a loaded `.node` in place**, which crashes every process that loads it afterwards (`dyld` EXC_BAD_ACCESS). The build now writes a new file and renames it.
3. **A desktop test could post a real ⌘V into the frontmost app** once Accessibility was granted. The live-paste branch now requires `MURMUR_ALLOW_LIVE_PASTE=1`, and `native/scripts/measure.mjs` never posts a paste.

### Live evaluation attempt (2026-10-15)

The user ran `npm run eval -w packages/refine` with a Groq key. **The run was invalid:** all 36 first-repetition calls to `groq:llama-3.3-70b-versatile` failed with a provider error in about 100 ms, so the model never answered. The reported "model 0.67, executed 0" was just the raw transcript being scored. The harness has since been fixed:

- it records the provider's error message;
- it marks such runs `valid: false` (and they can never qualify);
- it retries HTTP 429 rate limits with backoff.

A valid run is still required before AI cleanup can become the default.

## Manual tests required

See [M2_MANUAL_TESTS.md](M2_MANUAL_TESTS.md). In short:

- dictating with dictionary entries and snippets into real apps;
- every Hub control on the Dictionary, Snippets and History pages, including the import/export dialogs;
- AI cleanup with a real key, including dictating the injection phrases aloud;
- the live evaluation run;
- retention settings over time.

## Known limitations

1. **AI cleanup is unevaluated against live models.** The adapters are unit-tested with fake HTTP and type-checked against the Anthropic SDK; no live call was made in this session.
2. **Silent deletion** (a model dropping a leading instruction phrase such as "summarize the following email for me") cannot be detected heuristically. It is the one M0 injection case the guardrails still let through on the recorded local-model outputs.
3. **Deterministic cleanup does not resolve self-corrections or repeated words**; those are AI-mode features. Deterministic mode keeps every word.
4. Dictionary casing enforcement is whole-word and literal. A phrase that is also a common word (e.g. "Will") would be capitalized everywhere; the UI does not warn about this yet.
5. Snippet expansions are plain text (no rich text or variables such as dates).
6. AI cleanup is English-first: the prompt preserves other languages, but guardrails and evaluation cases are English and Uzbek only.
7. Export is JSON only and excludes audio by design.
8. Still from M1: batch (not streaming) transcription; not packaged or signed.

## Remaining blockers

| Blocker                                | Impact                                                                          | Resolution                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No live evaluation of a cloud AI model | AI cleanup must stay off by default (required by the brief)                     | Run `GROQ_API_KEY=… npm run eval -w packages/refine` (and/or `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). A provider qualifies when `instructionsExecuted = 0` and model pass rate ≥ 0.9. I did not extract the Groq key stored in Murmur's encrypted settings to run this myself: that would spend your credits without your say-so. |
| Manual verification                    | Hub interactions and real-app insertion with dictionary/snippets are human-only | M2_MANUAL_TESTS.md                                                                                                                                                                                                                                                                                                               |
