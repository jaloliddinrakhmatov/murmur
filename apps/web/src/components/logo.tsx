"use client";

import Link from "next/link";
import { useRef } from "react";
import { gsap } from "../motion/gsap.ts";
import { useMotion } from "../motion/use-motion.ts";

const PILL = "M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7Z";
// The same mark as five voice bars (a compound path, so MorphSVG splits the pill into bars).
const BARS = [
  [4, 3.4],
  [8, 6],
  [12, 9],
  [16, 6.4],
  [20, 4],
]
  .map(([x, h]) => {
    const hh = 12 - h;
    const r = 1.2;
    return `M${x - r} ${hh + r}a${r} ${r} 0 0 1 ${2 * r} 0V${24 - hh - r}a${r} ${r} 0 0 1 ${-2 * r} 0Z`;
  })
  .join("");

/** The Murmur pill mark, the same shape as the desktop app's (static). */
export function MurmurMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={PILL} fill="var(--m-fg)" />
      <circle cx="16" cy="12" r="2.1" fill="var(--m-accent)" />
    </svg>
  );
}

/**
 * The animated mark. `intro`: on load the pill becomes voice bars and settles back (MorphSVG).
 * Always: hovering the logo repeats the morph, and the ember dot breathes now and then.
 */
function AnimatedMark({ size = 28, intro }: { size?: number; intro: boolean }) {
  const root = useRef<SVGSVGElement>(null);
  const pill = useRef<SVGPathElement>(null);
  const dot = useRef<SVGCircleElement>(null);

  useMotion(() => {
    const p = pill.current;
    const d = dot.current;
    const host = root.current?.closest("a");
    if (!p || !d || !host) return;

    const morph = gsap.timeline({ paused: true });
    morph
      .to(p, { morphSVG: BARS, duration: 0.6, ease: "power3.inOut" })
      .to(d, { scale: 1.25, duration: 0.6, ease: "power3.inOut" }, 0)
      .to(p, { morphSVG: PILL, duration: 0.7, ease: "power3.inOut" }, "+=0.35")
      .to(d, { scale: 1, duration: 0.7, ease: "power3.inOut" }, "<");

    if (intro) morph.delay(0.5).play();

    const play = () => {
      if (!morph.isActive()) morph.restart();
    };
    host.addEventListener("pointerenter", play);
    host.addEventListener("focus", play);

    const breath = gsap.to(d, {
      scale: 1.3,
      duration: 1.1,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
      repeatDelay: 4,
      delay: 4,
      paused: true,
    });
    const idle = gsap.delayedCall(intro ? 3 : 1, () => {
      if (!morph.isActive()) breath.play();
    });

    return () => {
      host.removeEventListener("pointerenter", play);
      host.removeEventListener("focus", play);
      idle.kill();
    };
  }, root);

  return (
    <svg
      ref={root}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      className="overflow-visible"
    >
      <path ref={pill} d={PILL} fill="var(--m-fg)" />
      <circle
        ref={dot}
        cx="16"
        cy="12"
        r="2.1"
        fill="var(--m-accent)"
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      />
    </svg>
  );
}

export function Logo({ intro = false }: { intro?: boolean }) {
  return (
    <Link
      href="/"
      className="inline-flex items-center gap-2"
      aria-label="Murmur home"
    >
      <AnimatedMark intro={intro} />
      <span className="font-serif text-[1.65rem] leading-none font-medium tracking-tight">
        Murmur
      </span>
    </Link>
  );
}
