// Clipboard-first insertion (approved for M1). Policy, in order:
//   1. Secure Event Input or an AX secure field → reject; nothing is copied.
//   2. The frontmost app must still be the one focused at release → otherwise copy only, with a hint.
//   3. Paste via the native chain with Accessibility insertion disabled (clipboard + Cmd+V).
//   4. Restore the user's clipboard after a per-app delay, only if nothing newer was copied.
// Without the Post Event permission the native chain already degrades to clipboard-only.
import type { Inserter, InsertOutcome, TargetSnapshot } from "../core/types.ts";
import type { NativeAddon } from "./addon.ts";

/** Apps known to read the pasteboard late (M0 reference audit: Office ≈ 3 s, remote desktops ≈ 5 s). */
const RESTORE_DELAYS: [RegExp, number][] = [
  [/^com\.microsoft\./, 3000],
  [
    /^(com\.microsoft\.rdc|com\.citrix|com\.vmware|com\.teamviewer|com\.anydesk|com\.realvnc|com\.parallels)/,
    5000,
  ],
];
const DEFAULT_RESTORE_MS = 500;

/** What the native layer says when it refuses a password field; the controller knows one name. */
const NATIVE_SECURE_REASONS = new Set([
  "secure-event-input",
  "secure-text-field",
]);

export function restoreDelayFor(bundleId: string | null): number {
  if (!bundleId) return DEFAULT_RESTORE_MS;
  let delay = DEFAULT_RESTORE_MS;
  for (const [re, ms] of RESTORE_DELAYS)
    if (re.test(bundleId)) delay = Math.max(delay, ms);
  return delay;
}

export interface InsertionDecision {
  action: "reject" | "copy-only" | "paste";
  reason?: string;
}

/** Pure policy, unit-tested separately from the native calls. */
export function decideInsertion(
  target: TargetSnapshot,
  nowFrontBundleId: string | null,
  secureNow: boolean,
  ownPid: number | null = null,
): InsertionDecision {
  if (target.secure || secureNow)
    return { action: "reject", reason: "secure-field" };
  // Murmur's own windows are never a target: the user forgot to click into another app.
  if (ownPid != null && target.pid === ownPid)
    return { action: "copy-only", reason: "self-target" };
  if (
    target.appBundleId &&
    nowFrontBundleId &&
    target.appBundleId !== nowFrontBundleId
  )
    return { action: "copy-only", reason: "target-changed" };
  return { action: "paste" };
}

export class ClipboardFirstInserter implements Inserter {
  private readonly native: NativeAddon;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;

  constructor(
    native: NativeAddon,
    log: ClipboardFirstInserter["log"],
    schedule: ClipboardFirstInserter["schedule"] = (fn, ms) =>
      void setTimeout(fn, ms),
  ) {
    this.native = native;
    this.log = log;
    this.schedule = schedule;
  }

  async insert(text: string, target: TargetSnapshot): Promise<InsertOutcome> {
    const front = this.native.frontmostApp();
    const decision = decideInsertion(
      target,
      front?.bundleId ?? null,
      this.native.permissionStatus().secureEventInput,
      process.pid,
    );
    if (decision.action === "reject")
      return { strategy: "rejected", reason: decision.reason };
    if (decision.action === "copy-only") {
      this.native.clipboardWriteText(text, true);
      return { strategy: "clipboard-only", reason: decision.reason };
    }
    const r = this.native.insertText(text, {
      allowAccessibility: false,
      allowPaste: true,
      modifierWaitMs: 600,
    });
    this.log("insert.native", {
      strategy: r.strategy,
      reason: r.reason,
      steps: r.steps,
      elapsedMs: r.elapsedMs,
    });
    if (r.strategy === "rejected")
      return {
        strategy: "rejected",
        reason: NATIVE_SECURE_REASONS.has(r.reason ?? "")
          ? "secure-field"
          : (r.reason ?? "rejected"),
      };
    if (
      r.strategy === "clipboard-paste" &&
      r.snapshotId != null &&
      r.changeCountAfterWrite != null
    ) {
      const { snapshotId, changeCountAfterWrite } = r;
      this.schedule(() => {
        const restored = this.native.clipboardRestore(
          snapshotId,
          changeCountAfterWrite,
        );
        this.log(
          "clipboard.restore",
          restored as unknown as Record<string, unknown>,
        );
        // Not restoring is expected when the user copied something newer; any other reason
        // (e.g. a clipboard too large to snapshot) means their previous content was replaced.
        if (!restored.restored)
          this.log("clipboard.restore.skipped", { reason: restored.reason });
      }, restoreDelayFor(target.appBundleId));
      return { strategy: "clipboard-paste" };
    }
    return {
      strategy: "clipboard-only",
      reason: r.reason ?? "paste-unavailable",
    };
  }

  /** Used by History "copy" and by retry: transient write, no restore (the user wants it on the clipboard). */
  copy(text: string): void {
    this.native.clipboardWriteText(text, false);
  }
}
