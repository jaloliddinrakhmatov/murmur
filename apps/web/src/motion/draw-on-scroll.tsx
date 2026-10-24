"use client";

import { useRef, type ReactNode } from "react";
import { gsap } from "./gsap.ts";
import { useMotion } from "./use-motion.ts";

/**
 * DrawOnScroll: self-draws the strokes inside it (every element with `data-draw`: path, line,
 * rect, circle…) when it scrolls into view, with a stagger. The SVG is complete in the server
 * HTML; the stroke is retracted by JS only. Optional `data-fill` elements fade in afterwards.
 */
export function DrawOnScroll({
  children,
  className,
  duration = 1.8,
  stagger = 0.14,
  delay = 0,
  eager = false,
}: {
  children: ReactNode;
  className?: string;
  duration?: number;
  stagger?: number;
  delay?: number;
  eager?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useMotion(() => {
    const el = ref.current;
    if (!el) return;
    const strokes = el.querySelectorAll("[data-draw]");
    const fills = el.querySelectorAll("[data-fill]");
    const tl = gsap.timeline({
      delay,
      scrollTrigger: eager
        ? undefined
        : { trigger: el, start: "top 80%", once: true },
    });
    tl.fromTo(
      strokes,
      { drawSVG: "0%" },
      { drawSVG: "100%", duration, stagger, ease: "power2.inOut" },
    );
    if (fills.length) {
      tl.from(
        fills,
        { opacity: 0, duration: 0.8, stagger: 0.08, ease: "power1.out" },
        "-=0.6",
      );
    }
    el.setAttribute("data-m-set", "");
  }, ref);

  return (
    <div ref={ref} className={className} data-m-hide={eager ? "" : undefined}>
      {children}
    </div>
  );
}
