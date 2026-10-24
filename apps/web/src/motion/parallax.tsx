"use client";

import { useRef, type ReactNode } from "react";
import { gsap } from "./gsap.ts";
import { useMotion } from "./use-motion.ts";

/**
 * Parallax: drifts its content vertically while it crosses the viewport, scrubbed to the scroll.
 * `speed` is the travel as a fraction of the element's own height (0.1 = 10% each way); negative
 * values move against the scroll. Transform only, so it never shifts the layout.
 */
export function Parallax({
  children,
  className,
  speed = 0.1,
}: {
  children: ReactNode;
  className?: string;
  speed?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useMotion(() => {
    const el = ref.current;
    if (!el) return;
    gsap.fromTo(
      el,
      { yPercent: -speed * 100 },
      {
        yPercent: speed * 100,
        ease: "none",
        scrollTrigger: {
          trigger: el,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      },
    );
  }, ref);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
