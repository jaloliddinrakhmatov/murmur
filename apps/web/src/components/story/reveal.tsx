"use client";

import { NO_PREF, ScrollTrigger, gsap, useGSAP } from "./motion.ts";

/**
 * Fades up everything marked data-rv as it scrolls into view. Mount once, last on the page.
 * Reduced motion leaves the markup untouched.
 */
export function RevealController() {
  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add(NO_PREF, () => {
      const els = gsap.utils.toArray<HTMLElement>("[data-rv]");
      gsap.set(els, { opacity: 0, y: 28 });
      ScrollTrigger.batch(els, {
        start: "top 92%",
        once: true,
        onEnter: (batch) =>
          gsap.to(batch, {
            opacity: 1,
            y: 0,
            duration: 0.9,
            ease: "power3.out",
            stagger: 0.08,
            overwrite: "auto",
          }),
      });
    });
    // Web fonts change line heights; measure again once they are in.
    let alive = true;
    document.fonts?.ready.then(() => alive && ScrollTrigger.refresh());
    return () => {
      alive = false;
      mm.revert();
    };
  });
  return null;
}
