# M0 prototypes

Throwaway technical prototypes for Milestone 0. They de-risk the native layer, the overlay, speech-to-text, and LLM cleanup before M1. Nothing here is production code. Results and verdicts live in `docs/M0_RESULTS.md`, `docs/M0_NATIVE_TESTS.md`, `docs/M0_BENCHMARKS.md`, and `docs/M0_DECISIONS.md`.

| Directory        | Prototype                         | Stack                                                                                   |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| `native/`        | A (keyboard) + C (text insertion) | Rust workspace: `murmur-core` (pure logic) + `murmur-native` (napi-rs addon, macOS FFI) |
| `overlay/`       | B (floating Capsule)              | Electron 44.5.1, sandboxed renderer, uses the native addon                              |
| `speech-bench/`  | D (speech-to-text)                | Node 24 TypeScript (type stripping, no build step)                                      |
| `cleanup-bench/` | E (LLM cleanup)                   | Node 24 TypeScript, `@anthropic-ai/sdk` 0.131.0                                         |
| `scripts/`       | Local provider setup              | bash + Python stdlib                                                                    |
| `lib/`           | Shared stats helpers              | TypeScript                                                                              |

## Prerequisites

- macOS 13+ on Apple Silicon (tested: macOS 27.0.1, M2, 8 GB)
- Node 24+
- Rust toolchain: `curl https://sh.rustup.rs -sSf | sh -s -- -y --no-modify-path --profile minimal`, then `source ~/.cargo/env`
- Xcode Command Line Tools (clang)
- About 4.5 GB free for local models and samples (`prototypes/.cache/`, gitignored)
- If you run Electron from a VS Code/Cursor terminal, the npm scripts already unset the inherited `ELECTRON_RUN_AS_NODE`.

## Run everything

```bash
# Local providers and public samples: whisper.cpp v1.9.4, llama.cpp b11306, FLEURS en/uz clips, Qwen2.5 1.5B/3B
prototypes/scripts/setup-local-providers.sh

# A + C: native addon (no permissions needed for the automated suite)
cd native
npm run build
npm test            # 23 Rust + 23 Node tests (1 skipped without Input Monitoring)
npm run measure     # writes results/native-measurements.json (uses and restores your clipboard)

# B: overlay
cd ../overlay
npm install
npm run selftest    # opens windows briefly and launches/quits TextEdit if it is not already running
npm start           # interactive: hold Ctrl+Opt+Space to drive the capsule

# D: speech benchmark
cd ../speech-bench
npm test
npm run prepare-samples
npm run bench       # ~30–60 min on an 8 GB M2; add --sets=en-short --limit=3 for a smoke run

# E: cleanup benchmark
cd ../cleanup-bench
npm install
npm test
npm run bench       # add --target-ms=1500 to change the latency target, --providers=rules to filter
```

## Cloud providers (not run in M0: no credentials)

The adapters are enabled automatically when credentials are present. Prices are never assumed for speech: supply them so cost can be estimated.

| Provider        | Env vars                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| OpenAI speech   | `OPENAI_API_KEY`, optional `OPENAI_STT_MODEL` (default `gpt-4o-transcribe`), `OPENAI_STT_USD_PER_MIN` |
| Groq speech     | `GROQ_API_KEY`, optional `GROQ_STT_MODEL`, `GROQ_STT_USD_PER_MIN`                                     |
| Deepgram speech | `DEEPGRAM_API_KEY`, optional `DEEPGRAM_MODEL` (default `nova-3`), `DEEPGRAM_USD_PER_MIN`              |
| Claude cleanup  | `ANTHROPIC_API_KEY` → runs `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`                 |

Running the cloud benchmarks costs money. The cleanup suite is 36 cases × 3 repetitions per model.

## Manual tests that need macOS permissions

See the runbook at the end of `docs/M0_NATIVE_TESTS.md`. Grant permissions to Terminal.app temporarily, not to your editor.
