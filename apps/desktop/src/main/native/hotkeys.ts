// Global hotkeys through Carbon (no permission required; validated in M0 for modifier+key combos).
// Push-to-talk is registered permanently; Esc is registered as a cancel key for the duration of a
// recording only, so it never steals Escape from other apps otherwise. The optional
// last-transcript shortcuts (Stage 6B) are registered only when the user sets them.
import type { CancelHotkeyPort } from "../core/types.ts";
import type { ShortcutAction } from "../../shared/ipc.ts";
export { BINDING_NAMES } from "../../shared/ipc.ts";
import type { NativeAddon } from "./addon.ts";
import { EDITING_CONFLICT_CODES } from "../../shared/shortcut-conflicts.ts";

const PTT_ID = 1;
const CANCEL_ID = 2;
const ACTION_IDS: Record<ShortcutAction, number> = {
  pasteLast: 3,
  copyLast: 4,
  copyOriginal: 5,
  openScratchpad: 6,
  transformViewChanges: 7,
  commandMode: 10,
  pressEnter: 11,
  startNotetaker: 12,
};
export const ACTIONS = Object.keys(ACTION_IDS) as ShortcutAction[];
/** Transform shortcuts (Stage 9C) use ids from here up, one per transform. */
const TRANSFORM_BASE_ID = 100;
/** Esc while the Transform panel is open (it can't take keyboard focus). */
const PANEL_ESC_ID = 9;

export interface ShortcutStatus {
  combo: string;
  registered: boolean;
  error: string | null;
}

/** "transform:<id>" for a transform's shortcut. */
type Binding = ShortcutAction | "pushToTalk" | `transform:${string}`;
type Replaced =
  | { ok: true; status: ShortcutStatus | null }
  | { ok: false; error: string; status: ShortcutStatus | null };

/** True when a saved shortcut only passes because of `keepSaved` (the native check would refuse it). */
function keptOptions(warnings: string[]): boolean {
  return warnings.some((w) =>
    (EDITING_CONFLICT_CODES as readonly string[]).includes(w),
  );
}

export class CarbonHotkeys implements CancelHotkeyPort {
  private status: ShortcutStatus = {
    combo: "",
    registered: false,
    error: null,
  };
  private readonly actionStatus = new Map<ShortcutAction, ShortcutStatus>();
  /** Transform id → its Carbon id and status. */
  private readonly transformStatus = new Map<
    string,
    { hotkeyId: number; status: ShortcutStatus }
  >();
  private onTransform: (id: string) => void = () => {};
  private suspended = false;
  private readonly native: NativeAddon;
  private readonly onPushToTalk: (kind: "down" | "up") => void;
  private readonly onAction: (
    action: ShortcutAction,
    kind: "pressed" | "released",
  ) => void;

  constructor(
    native: NativeAddon,
    onPushToTalk: (kind: "down" | "up") => void,
    onAction: (
      action: ShortcutAction,
      kind: "pressed" | "released",
    ) => void = () => {},
  ) {
    this.native = native;
    this.onPushToTalk = onPushToTalk;
    this.onAction = onAction;
  }

  get current(): ShortcutStatus {
    return this.status;
  }

  /** The optional shortcuts; null when unset. */
  get actions(): Record<ShortcutAction, ShortcutStatus | null> {
    return Object.fromEntries(
      ACTIONS.map((a) => [a, this.actionStatus.get(a) ?? null]),
    ) as Record<ShortcutAction, ShortcutStatus | null>;
  }

  /** Validation for the settings UI, before anything is registered. */
  check(
    combo: string,
    binding: Binding = "pushToTalk",
    keepSaved = false,
  ): {
    normalized: string | null;
    errors: string[];
    warnings: string[];
    backend: string | null;
  } {
    try {
      // The native rules know push-to-talk and press actions ("pasteLast"); all three optional
      // shortcuts are press actions.
      const v = this.native.validateShortcut(
        combo,
        binding === "pushToTalk" ? "pushToTalk" : "pasteLast",
      );
      let errors = [...v.errors];
      let warnings = [...v.warnings];
      if (keepSaved) {
        // A shortcut saved before the editing-keys rule existed keeps working; the Hub warns.
        const kept = errors.filter((e) =>
          (EDITING_CONFLICT_CODES as readonly string[]).includes(e),
        );
        errors = errors.filter((e) => !kept.includes(e));
        warnings = [...warnings, ...kept];
      }
      // Carbon only (R6 — Input Monitoring for modifier-only keys and fn — is not approved).
      if (v.backend !== "carbon")
        errors.push("needs-input-monitoring (not available in this version)");
      const taken = errors.length ? null : this.usedBy(v.normalized, binding);
      if (taken) errors.push(`used-by:${taken}`);
      return {
        normalized: v.normalized,
        errors,
        warnings,
        backend: v.backend,
      };
    } catch (err) {
      return {
        normalized: null,
        errors: [String((err as Error).message)],
        warnings: [],
        backend: null,
      };
    }
  }

  /** Which other Murmur binding already uses `normalized`, if any. */
  private usedBy(
    normalized: string,
    self: Binding,
  ): Exclude<Binding, `transform:${string}`> | "transform" | null {
    const same = (combo: string) => {
      try {
        return (
          this.native.validateShortcut(combo, "pasteLast").normalized ===
          normalized
        );
      } catch {
        return false;
      }
    };
    if (self !== "pushToTalk" && this.status.combo && same(this.status.combo))
      return "pushToTalk";
    for (const [action, s] of this.actionStatus)
      if (action !== self && same(s.combo)) return action;
    for (const [id, t] of this.transformStatus)
      if (`transform:${id}` !== self && same(t.status.combo))
        return "transform";
    return null;
  }

  /** Called when a transform's shortcut is pressed. */
  setTransformHandler(handler: (id: string) => void): void {
    this.onTransform = handler;
  }

  /**
   * Registers exactly these transform shortcuts (unregistering any others). Each is checked
   * against Murmur's other bindings first; one that fails doesn't stop the rest.
   */
  bindTransforms(
    bindings: { id: string; combo: string }[],
  ): Map<string, ShortcutStatus> {
    for (const t of this.transformStatus.values())
      this.native.unregisterHotkey(t.hotkeyId);
    this.transformStatus.clear();
    const result = new Map<string, ShortcutStatus>();
    bindings.forEach(({ id, combo }, i) => {
      const hotkeyId = TRANSFORM_BASE_ID + i;
      const check = this.check(combo, `transform:${id}`, true);
      let status: ShortcutStatus;
      if (check.errors.length)
        status = { combo, registered: false, error: check.errors.join(", ") };
      else {
        const r = this.suspended
          ? { ok: true, normalized: check.normalized ?? combo }
          : this.native.registerHotkey(
              hotkeyId,
              combo,
              {
                exclusive: true,
                action: "pasteLast",
                skipValidation: keptOptions(check.warnings),
              },
              (e) => {
                if (e.kind === "pressed") this.onTransform(id);
              },
            );
        status = r.ok
          ? { combo: r.normalized ?? combo, registered: true, error: null }
          : {
              combo,
              registered: false,
              error: registrationError(r as { status: number; error?: string }),
            };
      }
      this.transformStatus.set(id, { hotkeyId, status });
      result.set(id, status);
    });
    return result;
  }

  /** Esc closes the Transform panel while it is open; returns the release function. */
  armPanelEscape(onEscape: () => void): () => void {
    const r = this.native.registerHotkey(
      PANEL_ESC_ID,
      "escape",
      { exclusive: false, action: "cancel" },
      () => onEscape(),
    );
    if (!r.ok) return () => {};
    return () => {
      this.native.unregisterHotkey(PANEL_ESC_ID);
    };
  }

  /** Registers the push-to-talk combo, replacing any previous one. Returns the resulting status. */
  bind(combo: string, strict = false): ShortcutStatus {
    this.native.unregisterHotkey(PTT_ID);
    const check = this.check(combo, "pushToTalk", !strict);
    if (check.errors.length) {
      this.status = {
        combo,
        registered: false,
        error: check.errors.join(", "),
      };
      return this.status;
    }
    const r = this.native.registerHotkey(
      PTT_ID,
      combo,
      {
        exclusive: true,
        action: "pushToTalk",
        skipValidation: keptOptions(check.warnings),
      },
      (e) => {
        this.onPushToTalk(e.kind === "pressed" ? "down" : "up");
      },
    );
    this.status = r.ok
      ? { combo: r.normalized ?? combo, registered: true, error: null }
      : { combo, registered: false, error: registrationError(r) };
    return this.status;
  }

  /**
   * Registers `combo` in place of the current shortcut. If it can't be registered (invalid, or
   * taken by another app), the previous shortcut is registered again, so a working shortcut is
   * never lost to a failed change.
   */
  replace(
    combo: string,
  ):
    | { ok: true; status: ShortcutStatus }
    | { ok: false; error: string; status: ShortcutStatus } {
    const previous = this.status;
    const next = this.bind(combo, true);
    if (next.registered) return { ok: true, status: next };
    if (previous.registered) this.bind(previous.combo);
    else this.status = previous;
    return {
      ok: false,
      error: next.error ?? "registration failed",
      status: this.status,
    };
  }

  /**
   * Puts back a shortcut that was already saved, after a change could not be saved: the lenient
   * check, so one kept from before the editing-keys rule (like ctrl+d) still comes back.
   */
  restore(combo: string): ShortcutStatus {
    return this.bind(combo);
  }

  /** Registers (or, with null, removes) an optional shortcut. Other bindings are untouched. */
  bindAction(
    action: ShortcutAction,
    combo: string | null,
    strict = false,
  ): ShortcutStatus | null {
    const id = ACTION_IDS[action];
    this.native.unregisterHotkey(id);
    if (combo === null) {
      this.actionStatus.delete(action);
      return null;
    }
    // Checked against the other bindings without this one's old combo.
    this.actionStatus.delete(action);
    const check = this.check(combo, action, !strict);
    let status: ShortcutStatus;
    if (check.errors.length)
      status = { combo, registered: false, error: check.errors.join(", ") };
    else {
      const r = this.register(id, action, combo, keptOptions(check.warnings));
      status = r.ok
        ? { combo: r.normalized ?? combo, registered: true, error: null }
        : { combo, registered: false, error: registrationError(r) };
    }
    this.actionStatus.set(action, status);
    return status;
  }

  private register(
    id: number,
    action: ShortcutAction,
    combo: string,
    skipValidation: boolean,
  ) {
    return this.native.registerHotkey(
      id,
      combo,
      { exclusive: true, action: "pasteLast", skipValidation },
      (e) => this.onAction(action, e.kind),
    );
  }

  /**
   * Like `replace`, for an optional shortcut: a failed change leaves the previous binding
   * registered. Null clears it.
   */
  replaceAction(action: ShortcutAction, combo: string | null): Replaced {
    const previous = this.actionStatus.get(action) ?? null;
    const next = this.bindAction(action, combo, true);
    if (next === null || next.registered) return { ok: true, status: next };
    this.bindAction(action, previous?.registered ? previous.combo : null);
    if (previous && !previous.registered)
      this.actionStatus.set(action, previous);
    return {
      ok: false,
      error: next.error ?? "registration failed",
      status: this.actionStatus.get(action) ?? null,
    };
  }

  /**
   * Releases every Murmur shortcut while the shortcut recorder listens, so pressing a combo
   * Murmur already holds reaches the recorder instead of starting a dictation. Statuses are
   * kept; resuming registers them again. Any change to a binding resumes first (the service
   * does), so a saved shortcut is always one macOS really registered.
   */
  suspend(on: boolean): void {
    if (on === this.suspended) return;
    this.suspended = on;
    if (on) {
      this.native.unregisterHotkey(PTT_ID);
      for (const id of Object.values(ACTION_IDS))
        this.native.unregisterHotkey(id);
      for (const t of this.transformStatus.values())
        this.native.unregisterHotkey(t.hotkeyId);
      return;
    }
    if (this.status.registered) this.bind(this.status.combo);
    for (const [action, s] of [...this.actionStatus])
      if (s.registered) this.bindAction(action, s.combo);
    const transforms = [...this.transformStatus].flatMap(([id, t]) =>
      t.status.registered ? [{ id, combo: t.status.combo }] : [],
    );
    if (transforms.length) this.bindTransforms(transforms);
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  arm(onCancel: () => void): () => void {
    const r = this.native.registerHotkey(
      CANCEL_ID,
      "escape",
      { exclusive: false, action: "cancel" },
      () => onCancel(),
    );
    if (!r.ok) return () => {};
    return () => {
      this.native.unregisterHotkey(CANCEL_ID);
    };
  }

  dispose(): void {
    this.native.unregisterHotkey(PTT_ID);
    this.native.unregisterHotkey(CANCEL_ID);
    this.native.unregisterHotkey(PANEL_ESC_ID);
    for (const t of this.transformStatus.values())
      this.native.unregisterHotkey(t.hotkeyId);
    for (const id of Object.values(ACTION_IDS))
      this.native.unregisterHotkey(id);
  }
}

function registrationError(r: { status: number; error?: string }): string {
  return r.status === -9878
    ? "Shortcut is already used by another app"
    : (r.error ?? "registration failed");
}
