"use client";

import { useRef } from "react";
import { NO_PREF, gsap, useGSAP } from "./motion.ts";
import { SplitText } from "../../motion/gsap.ts";

/** A section title whose words rise out of their line when it scrolls into view. */
export function Title({
  children,
  className = "",
  id,
  as: Tag = "h2",
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
  as?: "h2" | "h3";
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        SplitText.create(el, {
          type: "lines,words",
          mask: "lines",
          linesClass: "tl-line",
          autoSplit: true,
          onSplit(self) {
            return gsap.from(self.words, {
              yPercent: 112,
              duration: 1.1,
              ease: "expo.out",
              stagger: 0.055,
              scrollTrigger: { trigger: el, start: "top 88%", once: true },
            });
          },
        });
      });
      return () => mm.revert();
    },
    { scope: ref },
  );
  return (
    <Tag ref={ref as never} id={id} className={`display ${className}`}>
      {children}
    </Tag>
  );
}
