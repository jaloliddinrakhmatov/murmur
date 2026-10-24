"use client";

import { useGSAP, gsap, MOTION_OK } from "./gsap.ts";
import type { RefObject } from "react";

/**
 * useMotion(setup, scope, deps): runs `setup` after hydration, only while the visitor has not asked
 * for reduced motion. Everything created inside (tweens, ScrollTriggers, SplitText) is reverted on
 * unmount, when `deps` change, and the moment the visitor turns reduced motion on, which restores
 * the plain, fully visible content. `setup` may return its own cleanup function.
 */
export function useMotion(
  setup: () => void | (() => void),
  scope: RefObject<Element | null>,
  deps: unknown[] = [],
) {
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MOTION_OK, () => setup());
      return () => mm.revert();
    },
    { scope, dependencies: deps, revertOnUpdate: true },
  );
}
