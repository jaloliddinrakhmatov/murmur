"use client";

import { useEffect, useRef } from "react";

/** Slow drifting light behind a section. Runs only while the section is on screen. */
export function Ambient() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        el.dataset.paused = entry.isIntersecting ? "false" : "true";
      },
      { rootMargin: "80px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="amb" aria-hidden="true">
      <i />
      <i />
    </div>
  );
}
