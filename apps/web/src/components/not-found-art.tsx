"use client";

import { useRef } from "react";
import { gsap } from "../motion/gsap.ts";
import { useMotion } from "../motion/use-motion.ts";

const PILL = "M60 40h80a20 20 0 0 1 0 40H60a20 20 0 0 1 0-40Z";
const BLOB = "M104 20c30-4 58 14 54 40s-26 42-58 38-54-20-50-44 22-30 54-34Z";
const ORB = "M100 22a38 38 0 1 1 0 76a38 38 0 1 1 0-76Z";

/**
 * The 404 mark: the Murmur pill softens into a drifting blob, then a circle, then back, with an
 * ember dot circling it. Static pill with reduced motion. Decorative.
 */
export function NotFoundArt() {
  const root = useRef<SVGSVGElement>(null);
  const shape = useRef<SVGPathElement>(null);
  const orbit = useRef<SVGGElement>(null);

  useMotion(() => {
    const p = shape.current;
    const o = orbit.current;
    if (!p || !o) return;
    const tl = gsap.timeline({ repeat: -1, defaults: { ease: "sine.inOut" } });
    tl.to(p, { morphSVG: BLOB, duration: 1.8 })
      .to(p, { morphSVG: ORB, duration: 1.6 })
      .to(p, { morphSVG: PILL, duration: 1.8 });
    gsap.to(root.current, {
      y: -8,
      duration: 2.6,
      ease: "sine.inOut",
      yoyo: true,
      repeat: -1,
    });
    gsap.to(o, {
      rotation: 360,
      svgOrigin: "100 60",
      duration: 9,
      ease: "none",
      repeat: -1,
    });
  }, root);

  return (
    <svg
      ref={root}
      viewBox="0 0 200 120"
      aria-hidden="true"
      className="mx-auto mb-8 h-auto w-44 sm:w-56"
    >
      <path ref={shape} d={PILL} fill="var(--m-fg)" />
      <g ref={orbit}>
        <circle cx="100" cy="8" r="6" fill="var(--m-accent)" />
      </g>
    </svg>
  );
}
