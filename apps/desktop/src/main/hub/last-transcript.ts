// The last-transcript actions (Stage 6A menu-bar items, Stage 6B shortcuts) with their results
// shown on the Capsule, the same way a dictation's result is. Paste goes through the dictation
// inserter (HubService.pasteLastTranscript), so its safety rules apply unchanged.
import type { ShortcutAction } from "../../shared/ipc.ts";
import type { InsertOutcome } from "../core/types.ts";

export interface LastTranscriptDeps {
  service: {
    pasteLastTranscript(): Promise<InsertOutcome | null>;
    copyLastTranscript(which: "final" | "raw"): boolean;
    lastTranscript(): { available: boolean; hasOriginal: boolean };
  };
  controller: {
    readonly currentPhase: string;
    announce(state: "inserted" | "copied" | "error", message?: string): void;
  };
  log: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

/** A second trigger within this window is the same press (key repeat, a bounce). */
export const REPEAT_GUARD_MS = 400;

export function lastTranscriptActions(d: LastTranscriptDeps) {
  const now = d.now ?? Date.now;

  /** Result messages match a dictation's (the same inserter outcomes). */
  const paste = async (): Promise<void> => {
    if (d.controller.currentPhase !== "idle") {
      d.log("lastTranscript.skipped", { reason: "dictating" });
      return;
    }
    const outcome = await d.service.pasteLastTranscript();
    if (!outcome)
      return d.controller.announce("error", "No dictation to paste yet");
    d.log("lastTranscript.paste", {
      strategy: outcome.strategy,
      reason: outcome.reason,
    });
    if (outcome.strategy === "clipboard-paste" || outcome.strategy === "direct")
      d.controller.announce("inserted");
    else if (outcome.strategy === "clipboard-only")
      d.controller.announce(
        "copied",
        outcome.reason === "self-target"
          ? "Murmur is in front — copied, press ⌘V"
          : outcome.reason === "target-changed"
            ? "App changed — copied, press ⌘V"
            : outcome.reason === "no-post-event-permission"
              ? "Paste is off — copied, press ⌘V"
              : "Copied — press ⌘V to paste",
      );
    else
      d.controller.announce(
        "error",
        outcome.reason === "secure-field"
          ? "Password field — not pasted"
          : "Couldn't paste here",
      );
  };

  const copy = (which: "final" | "raw"): void => {
    if (d.controller.currentPhase !== "idle") {
      d.log("lastTranscript.skipped", { reason: "dictating" });
      return;
    }
    if (d.service.copyLastTranscript(which))
      d.controller.announce("copied", "Copied — press ⌘V to paste");
    else
      d.controller.announce(
        "error",
        which === "raw" && d.service.lastTranscript().available
          ? "No original words for the last dictation"
          : "No dictation to copy yet",
      );
  };

  /**
   * Optional shortcuts. Copy acts on key-down; Paste on key-up, so the shortcut's own modifiers
   * are (nearly) released before ⌘V is sent (the inserter waits for the rest). Key repeat, and a
   * second press while a paste is still running, are ignored: one press is one action.
   */
  let busy = false;
  let lastAt = -Infinity;
  const onShortcut = (
    action: ShortcutAction,
    kind: "pressed" | "released",
  ): Promise<void> | void => {
    if (kind !== (action === "pasteLast" ? "released" : "pressed")) return;
    const t = now();
    if (busy || t - lastAt < REPEAT_GUARD_MS) return;
    lastAt = t;
    d.log("shortcut.action", { action });
    if (action === "copyLast") return copy("final");
    if (action === "copyOriginal") return copy("raw");
    busy = true;
    return paste().finally(() => {
      busy = false;
    });
  };

  return { paste, copy, onShortcut };
}
