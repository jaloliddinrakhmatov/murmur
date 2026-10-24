"use client";

import { useRef, type ElementType, type ReactNode } from "react";
import { gsap, SplitText } from "./gsap.ts";
import { useMotion } from "./use-motion.ts";

/**
 * SplitHeading: a real heading whose words rise out of a mask, line by line. The text stays one
 * selectable heading: SplitText sets an aria-label on it and hides the split pieces from screen
 * readers, and re-splits itself when the width changes. Inline <em> accents are kept.
 * - `chars` rises letter by letter instead (short, kinetic headlines).
 * - `eager` for headings visible at load (hidden by CSS until ready, never flashes).
 */
export function SplitHeading({
  as = "h2",
  children,
  className,
  id,
  delay = 0,
  chars = false,
  eager = false,
}: {
  as?: "h1" | "h2" | "h3" | "p";
  children: ReactNode;
  className?: string;
  id?: string;
  delay?: number;
  chars?: boolean;
  eager?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const Tag = as as ElementType;

  useMotion(() => {
    const el = ref.current;
    if (!el) return;
    const split = SplitText.create(el, {
      type: chars ? "lines,words,chars" : "lines,words",
      mask: "lines",
      maskClass: "m-mask",
      aria: "auto",
      autoSplit: true,
      onSplit(self) {
        const pieces = chars ? self.chars : self.words;
        const tween = gsap.from(pieces, {
          yPercent: 112,
          rotate: chars ? 6 : 3,
          duration: chars ? 0.9 : 1.1,
          delay,
          stagger: chars ? 0.022 : 0.07,
          ease: "expo.out",
          scrollTrigger: eager
            ? undefined
            : { trigger: el, start: "top 88%", once: true },
        });
        el.setAttribute("data-m-set", "");
        return tween;
      },
    });
    return () => split.revert();
  }, ref);

  return (
    <Tag
      ref={ref}
      id={id}
      className={className}
      data-m-hide={eager ? "" : undefined}
    >
      {children}
    </Tag>
  );
}
