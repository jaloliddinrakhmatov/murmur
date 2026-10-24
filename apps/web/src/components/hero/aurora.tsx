"use client";

import { useRef, type ReactNode } from "react";
import { useInView } from "../../motion/use-in-view.ts";
import "./hero.css";

/**
 * Aurora: slow, blurred colour fields and expanding rings behind its children, in the night band.
 * Pure CSS transforms (compositor only); paused while off screen, static with reduced motion.
 */
export function Aurora({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInView(ref);
  return (
    <div
      ref={ref}
      className={`aurora relative isolate overflow-hidden ${className ?? ""}`}
      data-active={active}
      style={{ clipPath: "inset(0 round 2rem)" }}
    >
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        aria-hidden="true"
      >
        <span
          className="aurora-blob -bottom-1/3 left-[8%] h-[70%] w-[46%]"
          style={{
            background: "rgba(255,138,76,0.3)",
            ["--t" as string]: "19s",
          }}
        />
        <span
          className="aurora-blob -bottom-1/2 right-[6%] h-[75%] w-[42%]"
          style={{
            background: "rgba(150,110,220,0.2)",
            ["--t" as string]: "23s",
          }}
        />
        <span
          className="aurora-blob -top-1/3 left-[36%] h-[50%] w-[30%]"
          style={{
            background: "rgba(255,170,110,0.1)",
            ["--t" as string]: "27s",
          }}
        />
        <span className="ring" style={{ ["--d" as string]: "0s" }} />
        <span className="ring" style={{ ["--d" as string]: "3s" }} />
        <span className="ring" style={{ ["--d" as string]: "6s" }} />
      </div>
      {children}
    </div>
  );
}
