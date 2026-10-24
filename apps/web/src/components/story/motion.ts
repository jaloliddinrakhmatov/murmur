"use client";

import { useRef } from "react";
import {
  REDUCED_MOTION,
  ScrollTrigger,
  gsap,
  useGSAP,
} from "../../motion/gsap.ts";

export { ScrollTrigger, gsap, useGSAP };

export const NO_PREF = "(prefers-reduced-motion: no-preference)";
/** The pinned, scroll-driven versions: wide screens that have not asked for less motion. */
export const WIDE_MOTION =
  "(min-width: 1024px) and (prefers-reduced-motion: no-preference)";
export { REDUCED_MOTION };

/**
 * A small looping scene that plays only while it is on screen. The markup is always the finished
 * state, so with reduced motion (or before scripts run) the visitor sees the complete picture.
 */
export function useLoop<T extends HTMLElement = HTMLDivElement>(
  build: (tl: gsap.core.Timeline, root: T) => void,
  repeatDelay = 1.4,
) {
  const ref = useRef<T>(null);
  useGSAP(
    () => {
      const root = ref.current;
      if (!root) return;
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay });
        build(tl, root);
        ScrollTrigger.create({
          trigger: root,
          start: "top 94%",
          end: "bottom 6%",
          onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
        });
        return () => {
          tl.kill();
        };
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  return ref;
}
