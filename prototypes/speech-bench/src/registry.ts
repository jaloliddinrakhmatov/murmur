// Provider registry: which providers exist, why one is unavailable, and static metadata for
// re-scoring saved records whose provider is not instantiated.
import { join } from "node:path";
import { WhisperCppProvider } from "./providers/whisper-cpp.ts";
import { cloudProviders } from "./providers/cloud.ts";
import type { TranscriptionProvider, UnavailableProvider } from "./types.ts";

const LOCAL_MODELS = [
  { id: "whisper.cpp:base", file: "ggml-base.bin", port: 8191 },
  {
    id: "whisper.cpp:large-v3-turbo-q5_0",
    file: "ggml-large-v3-turbo-q5_0.bin",
    port: 8192,
  },
];

export function buildProviders(root: string): {
  ready: TranscriptionProvider[];
  unavailable: UnavailableProvider[];
} {
  const binary = join(root, ".cache/src/whisper.cpp/build/bin/whisper-server");
  const ready: TranscriptionProvider[] = [];
  const unavailable: UnavailableProvider[] = [];
  for (const m of LOCAL_MODELS) {
    const modelPath = join(root, ".cache/models/whisper", m.file);
    const missing = WhisperCppProvider.available(binary, modelPath);
    if (missing) unavailable.push({ id: m.id, reason: missing });
    else
      ready.push(
        new WhisperCppProvider({ id: m.id, binary, modelPath, port: m.port }),
      );
  }
  const cloud = cloudProviders();
  return {
    ready: [...ready, ...cloud.ready],
    unavailable: [...unavailable, ...cloud.unavailable],
  };
}

export function providerMeta(id: string): {
  kind: "local" | "cloud";
  usdPerAudioMinute: number | null;
} {
  return id.startsWith("whisper.cpp:")
    ? { kind: "local", usdPerAudioMinute: 0 }
    : { kind: "cloud", usdPerAudioMinute: null };
}
