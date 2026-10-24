#!/usr/bin/env bash
# Downloads and builds the local (credential-free) benchmark providers and public speech samples
# used by M0 Prototypes D and E. Everything lands in prototypes/.cache (gitignored).
#
# Pinned versions (newest releases at least two weeks old on 2026-10-15):
#   whisper.cpp v1.9.4  (2026-09-11)
#   llama.cpp   b11306  (2026-09-30)
set -euo pipefail

WHISPER_TAG="v1.9.4"
LLAMA_TAG="b11306"
FLEURS_CLIPS_PER_LANG="${FLEURS_CLIPS_PER_LANG:-12}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/.cache"
mkdir -p "$CACHE"/{tools,src,models/whisper,models/llm,datasets/fleurs}

log() { printf '\n[setup] %s\n' "$*"; }

if [ ! -x "$CACHE/tools/venv/bin/cmake" ]; then
  log "Creating Python venv with cmake (avoids a system-wide install)"
  python3 -m venv "$CACHE/tools/venv"
  "$CACHE/tools/venv/bin/pip" install --quiet --upgrade pip cmake
fi
CMAKE="$CACHE/tools/venv/bin/cmake"

fetch_src() { # repo tag dir
  local repo=$1 tag=$2 dir=$3
  if [ ! -d "$CACHE/src/$dir" ]; then
    log "Downloading $repo@$tag"
    mkdir -p "$CACHE/src/$dir"
    curl -sSL "https://github.com/$repo/archive/refs/tags/$tag.tar.gz" | tar -xz -C "$CACHE/src/$dir" --strip-components=1
  fi
}

fetch_file() { # url dest
  if [ ! -s "$2" ]; then
    log "Downloading ${1##*/}"
    curl -sSL --fail -o "$2.part" "$1" && mv "$2.part" "$2"
  fi
}

fetch_src ggml-org/whisper.cpp "$WHISPER_TAG" whisper.cpp
if [ ! -x "$CACHE/src/whisper.cpp/build/bin/whisper-server" ]; then
  log "Building whisper.cpp (Metal)"
  "$CMAKE" -S "$CACHE/src/whisper.cpp" -B "$CACHE/src/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF >/dev/null
  "$CMAKE" --build "$CACHE/src/whisper.cpp/build" --target whisper-server whisper-cli -j 8 >/dev/null
fi

fetch_src ggml-org/llama.cpp "$LLAMA_TAG" llama.cpp
if [ ! -x "$CACHE/src/llama.cpp/build/bin/llama-server" ]; then
  log "Building llama.cpp (Metal)"
  "$CMAKE" -S "$CACHE/src/llama.cpp" -B "$CACHE/src/llama.cpp/build" -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF >/dev/null
  "$CMAKE" --build "$CACHE/src/llama.cpp/build" --target llama-server -j 8 >/dev/null
fi

HF=https://huggingface.co
fetch_file "$HF/ggerganov/whisper.cpp/resolve/main/ggml-base.bin" "$CACHE/models/whisper/ggml-base.bin"
fetch_file "$HF/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" "$CACHE/models/whisper/ggml-large-v3-turbo-q5_0.bin"
fetch_file "$HF/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf" "$CACHE/models/llm/qwen2.5-1.5b-instruct-q4_k_m.gguf"
fetch_file "$HF/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf" "$CACHE/models/llm/qwen2.5-3b-instruct-q4_k_m.gguf"

# FLEURS (Google, CC-BY-4.0): real read speech with reference transcripts. Only the first N clips of
# each test archive are streamed, so the full 290–520 MB archives are not downloaded.
for lang in en_us uz_uz; do
  out="$CACHE/datasets/fleurs/$lang"
  if [ ! -s "$out/manifest.tsv" ]; then
    log "Streaming $FLEURS_CLIPS_PER_LANG FLEURS clips for $lang"
    mkdir -p "$out"
    fetch_file "$HF/datasets/google/fleurs/resolve/main/data/$lang/test.tsv" "$out/test.tsv"
    # curl reports error 56 when the extractor stops reading early; that is expected.
    curl -sSL "$HF/datasets/google/fleurs/resolve/main/data/$lang/audio/test.tar.gz" 2>/dev/null |
      python3 -I "$ROOT/scripts/extract_fleurs.py" "$out" "$FLEURS_CLIPS_PER_LANG" || true
  fi
done

log "Done. Contents:"
du -sh "$CACHE"/* 2>/dev/null
