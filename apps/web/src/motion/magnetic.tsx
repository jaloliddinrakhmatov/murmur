"use client";

import { useRef, type ReactNode } from "react";
import { gsap } from "./gsap.ts";
import { useMotion } from "./use-motion.ts";

/**
 * Magnetic: the wrapped control leans a few pixels towards the pointer and springs back on leave.
 * `className` defaults to inline-block (pass your own display class to override). Fine pointers only (nothing happens on touch). It never changes layout or focus behaviour.
 */
export function Magnetic({
  children,
  className = "inline-block",
  strength = 0.28,
}: {
  children: ReactNode;
  className?: string;
  strength?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);

  useMotion(() => {
    const el = ref.current;
    if (!el || !window.matchMedia("(hover: hover) and (pointer: fine)").matches)
      return;
    const x = gsap.quickTo(el, "x", { duration: 0.5, ease: "power3.out" });
    const y = gsap.quickTo(el, "y", { duration: 0.5, ease: "power3.out" });
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      x((e.clientX - (r.left + r.width / 2)) * strength);
      y((e.clientY - (r.top + r.height / 2)) * strength);
    };
    const leave = () => {
      gsap.to(el, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.45)" });
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, ref);

  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}
