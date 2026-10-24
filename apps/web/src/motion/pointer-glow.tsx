"use client";

import { useEffect } from "react";

/**
 * PointerGlow: one passive listener for the whole site. While the pointer is over a `.card` (or any
 * `[data-glow]` element) it publishes --mx / --my, which the CSS uses for the ember glow that
 * follows the pointer. Renders nothing; does nothing on touch screens.
 */
export function PointerGlow() {
  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches)
      return;
    let frame = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      const e = last;
      if (!e || !(e.target instanceof Element)) return;
      const host = e.target.closest<HTMLElement>(".card, [data-glow]");
      if (!host) return;
      const r = host.getBoundingClientRect();
      host.style.setProperty("--mx", `${e.clientX - r.left}px`);
      host.style.setProperty("--my", `${e.clientY - r.top}px`);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      document.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return null;
}
