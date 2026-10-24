"use client";

import { useRef, type ElementType, type ReactNode } from "react";
import { gsap } from "./gsap.ts";
import { useMotion } from "./use-motion.ts";

type RevealTag =
  | "div"
  | "section"
  | "article"
  | "header"
  | "footer"
  | "ul"
  | "ol"
  | "li"
  | "p"
  | "span";

/**
 * Reveal: fades and lifts its content in when it scrolls into view (once).
 * - `stagger` animates the direct children one after another instead of the wrapper.
 * - `eager` is for content already on screen at load: the server HTML is hidden by CSS until the
 *   from-state is applied (and un-hidden after 3.5 s if scripts never run), so it never flashes.
 * The server renders the final content; the from-state is applied by JS after hydration only.
 */
export function Reveal({
  as = "div",
  children,
  className,
  delay = 0,
  y = 28,
  stagger = 0,
  eager = false,
}: {
  as?: RevealTag;
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  stagger?: number;
  eager?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const Tag = as as ElementType;

  useMotion(() => {
    const el = ref.current;
    if (!el) return;
    const targets = stagger ? Array.from(el.children) : el;
    gsap.from(targets, {
      y,
      opacity: 0,
      duration: 0.95,
      delay,
      stagger,
      ease: "power3.out",
      clearProps: "opacity,transform",
      scrollTrigger: eager
        ? undefined
        : { trigger: el, start: "top 88%", once: true },
    });
    el.setAttribute("data-m-set", "");
  }, ref);

  return (
    <Tag ref={ref} className={className} data-m-hide={eager ? "" : undefined}>
      {children}
    </Tag>
  );
}
