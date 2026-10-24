/** The Transform panel closes itself (and lets go of Esc) after this long without a change or a click. */
export const PANEL_IDLE_MS = 5 * 60_000;

interface IdleTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
}

/**
 * Runs `onIdle` once, `ms` after the last `touch()`. A floating panel that holds a global key
 * (Esc) while it is open uses this so it can never hold the key forever.
 */
export class IdleClose {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly ms: number;
  private readonly onIdle: () => void;
  private readonly timers: IdleTimers;

  constructor(
    ms: number,
    onIdle: () => void,
    timers: IdleTimers = { set: setTimeout, clear: clearTimeout },
  ) {
    this.ms = ms;
    this.onIdle = onIdle;
    this.timers = timers;
  }

  /** Something happened: start counting again. */
  touch(): void {
    this.clear();
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.onIdle();
    }, this.ms);
  }

  clear(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = null;
  }
}
