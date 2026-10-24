// Mute other audio while dictating (Stage E, Settings → System). Murmur mutes the Mac's output
// only if it isn't muted already, and unmutes only what it muted itself. A marker file records
// that Murmur muted the Mac, so a crash mid-dictation is undone at the next launch.

export interface MuteDeps {
  enabled: () => boolean;
  /** Null when the output device has no mute control. */
  isMuted: () => boolean | null;
  setMuted: (muted: boolean) => boolean;
  marker: { exists(): boolean; write(): void; remove(): void };
  log: (event: string, data?: Record<string, unknown>) => void;
}

export class OutputMuter {
  private readonly d: MuteDeps;
  private mutedByUs = false;

  constructor(deps: MuteDeps) {
    this.d = deps;
  }

  /** At launch: Murmur quit while it had muted the Mac, so give the sound back. */
  restoreAfterQuit(): void {
    if (!this.d.marker.exists()) return;
    try {
      this.d.setMuted(false);
    } catch {
      // No mute control any more (another output device): nothing to restore.
    }
    this.d.marker.remove();
    this.d.log("mute.restored-after-quit");
  }

  set(muted: boolean): void {
    try {
      if (muted) {
        if (this.mutedByUs || !this.d.enabled()) return;
        if (this.d.isMuted() !== false) return; // already muted, or can't be
        // The marker first: a crash right after muting must still be undone at the next launch.
        this.d.marker.write();
        let muted = false;
        try {
          muted = this.d.setMuted(true);
        } finally {
          if (!muted) this.d.marker.remove();
        }
        if (!muted) return;
        this.mutedByUs = true;
      } else if (this.mutedByUs) {
        this.mutedByUs = false;
        this.d.setMuted(false);
        this.d.marker.remove();
      }
    } catch (err) {
      this.d.log("mute.failed", { muted, error: (err as Error).name });
    }
  }
}
