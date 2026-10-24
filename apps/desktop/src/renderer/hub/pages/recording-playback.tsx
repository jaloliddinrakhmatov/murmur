// Play / pause for a History recording (row and detail sheet). One recording plays at a time;
// the state lives in `recordingPlayer`, so both places always agree.
import { useEffect, useSyncExternalStore } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { IconButton, useToast } from "../ui/index.ts";
import {
  recordingPlayer,
  setPlaybackErrorHandler,
  watchMicrophone,
} from "../playback.ts";
import {
  clock,
  NOT_WHILE_RECORDING,
  type PlayerState,
} from "../model/player.ts";

const IDLE_STATE: PlayerState = {
  id: null,
  phase: "idle",
  positionMs: 0,
  durationMs: 0,
};

/** The player's state for one dictation, and whether the microphone is open. */
export function useRecordingPlayback(id: string, available = true) {
  const toast = useToast();
  useEffect(() => {
    watchMicrophone();
    setPlaybackErrorHandler((message) =>
      toast({
        title:
          message === NOT_WHILE_RECORDING
            ? message
            : "Couldn't play the recording",
        description: message === NOT_WHILE_RECORDING ? undefined : message,
        tone: message === NOT_WHILE_RECORDING ? "info" : "error",
      }),
    );
  }, [toast]);
  // Rows that don't own the playback see a constant, so they don't re-render on every tick.
  const state = useSyncExternalStore(recordingPlayer.subscribe, () => {
    const current = recordingPlayer.getState();
    return current.id === id ? current : IDLE_STATE;
  });
  const micOpen = useSyncExternalStore(
    recordingPlayer.subscribe,
    () => recordingPlayer.recordingOpen,
  );
  // Whoever shows this recording goes away: stop it (and drop the bytes).
  useEffect(() => () => recordingPlayer.release(id), [id]);
  // The recording was deleted or expired while it played.
  useEffect(() => {
    if (!available) recordingPlayer.release(id);
  }, [available, id]);
  return {
    state,
    micOpen,
    toggle: () => void recordingPlayer.toggle(id),
  };
}

export function PlayRecordingButton({
  id,
  time,
  playback,
}: {
  id: string;
  /** Clock time of the dictation, for the accessible name ("8:47 AM"). */
  time: string;
  playback: ReturnType<typeof useRecordingPlayback>;
}) {
  const { state, micOpen, toggle } = playback;
  const playing = state.phase === "playing";
  const loading = state.phase === "loading";
  const name = `${playing ? "Pause" : state.phase === "paused" ? "Resume" : "Play"} recording, ${time}`;
  return (
    <IconButton
      size="sm"
      data-recording-button={id}
      data-playing={playing || undefined}
      label={
        micOpen ? NOT_WHILE_RECORDING : playing ? "Pause" : "Play recording"
      }
      aria-label={micOpen ? `${name} (not while recording)` : name}
      aria-disabled={micOpen || undefined}
      aria-busy={loading || undefined}
      icon={
        loading ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
        ) : playing ? (
          <Pause className="size-3.5" aria-hidden />
        ) : (
          <Play className="size-3.5" aria-hidden />
        )
      }
      className={micOpen ? "opacity-45" : undefined}
      onClick={() => {
        if (!micOpen) toggle();
      }}
    />
  );
}

/** A thin progress line (no animation of its own, so reduced motion needs nothing special). */
export function PlaybackProgress({
  state,
  className,
}: {
  state: PlayerState;
  className?: string;
}) {
  if (state.phase !== "playing" && state.phase !== "paused") return null;
  const pct = state.durationMs
    ? Math.min(100, (state.positionMs / state.durationMs) * 100)
    : 0;
  return (
    <div aria-hidden className={`h-0.5 bg-hairline ${className ?? ""}`}>
      <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "0:03 / 0:09" with a polite status, for the detail sheet. */
export function PlaybackReadout({ state }: { state: PlayerState }) {
  const active = state.phase === "playing" || state.phase === "paused";
  return (
    <>
      {active && (
        <span className="text-caption tabular-nums text-fg-secondary">
          {clock(state.positionMs)} / {clock(state.durationMs)}
        </span>
      )}
      <span role="status" className="sr-only">
        {state.phase === "playing"
          ? "Playing recording"
          : state.phase === "paused"
            ? "Recording paused"
            : ""}
      </span>
    </>
  );
}
