// The real playback engine for History recordings: the decrypted WAV lives in memory only, as a
// Blob URL on one HTMLAudioElement, and both are dropped as soon as playback stops.
import { hub } from "./bridge.ts";
import {
  RecordingPlayer,
  type PlaybackEngine,
  type PlaybackHooks,
} from "./model/player.ts";

function createEngine(
  bytes: ArrayBuffer,
  hooks: PlaybackHooks,
): PlaybackEngine {
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.preload = "auto";
  const report = () =>
    hooks.time(
      audio.currentTime * 1000,
      Number.isFinite(audio.duration) ? audio.duration * 1000 : 0,
    );
  audio.addEventListener("timeupdate", report);
  audio.addEventListener("loadedmetadata", report);
  audio.addEventListener("ended", hooks.ended);
  audio.addEventListener("error", hooks.failed);
  let disposed = false;
  return {
    play: () => audio.play(),
    pause: () => audio.pause(),
    dispose() {
      if (disposed) return;
      disposed = true;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    },
  };
}

/** Set by the History screen so a playback problem shows the usual toast. */
let reportError: (message: string) => void = () => {};
export function setPlaybackErrorHandler(handler: (message: string) => void) {
  reportError = handler;
}

export const recordingPlayer = new RecordingPlayer({
  load: (id) => hub.dictationAudio(id),
  createEngine,
  onError: (message) => reportError(message),
});

let watching = false;
/** Follows the microphone (dictation and meeting recordings) so nothing plays while it is open. */
export function watchMicrophone(): void {
  if (watching) return;
  watching = true;
  let dictation = false;
  let meeting = false;
  const apply = () => recordingPlayer.setMicOpen(dictation || meeting);
  hub.onDictationRecording((open) => {
    dictation = open;
    apply();
  });
  hub.onRecordingChanged((s) => {
    meeting = s.phase !== "idle";
    apply();
  });
  void hub.dictationRecording().then(
    (open) => {
      dictation = open;
      apply();
    },
    () => {},
  );
  void hub.recordingState().then(
    (s) => {
      meeting = s.phase !== "idle";
      apply();
    },
    () => {},
  );
}
