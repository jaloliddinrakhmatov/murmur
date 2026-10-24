"use client";

import { useRef } from "react";
import type { IconName } from "../../content/features.ts";
import { Icon } from "../icons.tsx";
import { NO_PREF, gsap } from "./motion.ts";

/** A line icon that draws itself again when its card is hovered or focused. */
export function AnimIcon({
  name,
  size = 22,
  className = "",
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const play = () => {
    const el = ref.current;
    if (!el || !window.matchMedia(NO_PREF).matches) return;
    const shapes = el.querySelectorAll("svg > *");
    gsap.fromTo(
      shapes,
      { drawSVG: "0%" },
      {
        drawSVG: "100%",
        duration: 0.8,
        ease: "power2.inOut",
        stagger: 0.1,
        overwrite: true,
      },
    );
  };
  return (
    <span
      ref={ref}
      className={`anim-icon ${className}`}
      data-anim-icon
      onPointerEnter={play}
    >
      <Icon name={name} size={size} />
    </span>
  );
}
