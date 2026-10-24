import type { TargetProbe, TargetSnapshot } from "../core/types.ts";
import type { NativeAddon } from "./addon.ts";

/** Frontmost app (NSWorkspace — the window-list heuristic was measured wrong in M0) plus the secure-input signal. */
export class NativeTargetProbe implements TargetProbe {
  private readonly native: NativeAddon;
  constructor(native: NativeAddon) {
    this.native = native;
  }

  snapshot(): TargetSnapshot {
    const app = this.native.frontmostApp();
    const perms = this.native.permissionStatus();
    let secure = perms.secureEventInput;
    if (perms.accessibility) {
      const el = this.native.focusedElement();
      if (el.ok && el.isSecure) secure = true;
    }
    return {
      appBundleId: app?.bundleId ?? null,
      appName: app?.name ?? null,
      pid: app?.pid ?? null,
      secure,
      takenAt: Date.now(),
    };
  }
}
