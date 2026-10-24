"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion } from "../../motion/use-reduced-motion.ts";
import { voiceSignal } from "../../motion/voice-signal.ts";
import "./hero.css";

/**
 * The hero's background. The server renders a static gradient with faint wave lines (also what
 * you get with reduced motion, without WebGL, or if the GPU is too slow). After the page is idle
 * the WebGL voice field is loaded on top of it and the static layer fades out.
 */
export function VoiceField() {
  const host = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = host.current;
    if (!el || reduced) return;
    let handle: { destroy: () => void } | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let cancelled = false;

    const start = () => {
      import("./voice-field-gl.ts").then(({ startVoiceField }) => {
        if (cancelled) return;
        canvas = document.createElement("canvas");
        canvas.className = "voice-canvas";
        canvas.setAttribute("aria-hidden", "true");
        el.appendChild(canvas);
        handle = startVoiceField({
          canvas,
          energy: voiceSignal.get,
          onGiveUp: () => {
            el.dataset.gl = "off";
            canvas?.remove();
          },
        });
        if (handle) {
          requestAnimationFrame(() => {
            el.dataset.gl = "on";
          });
        } else {
          canvas.remove();
        }
      });
    };

    // After first paint, so the canvas never competes with the headline for the main thread.
    const idle = window.setTimeout(start, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(idle);
      handle?.destroy();
      canvas?.remove();
      delete el.dataset.gl;
    };
  }, [reduced]);

  return (
    <div
      ref={host}
      className="voice-field absolute inset-0 -z-10"
      aria-hidden="true"
    >
      <svg
        className="voice-static"
        viewBox="0 0 1440 600"
        preserveAspectRatio="none"
      >
        <g fill="none" strokeLinecap="round">
          <path
            d="M0 420c140-50 250 40 420-4s290-70 470-20 360 40 550-14"
            stroke="var(--m-accent)"
            strokeOpacity="0.35"
            strokeWidth="1.4"
          />
          <path
            d="M0 450c170 30 300-60 470-24s300 40 480-4 330-20 490 12"
            stroke="var(--m-fg)"
            strokeOpacity="0.12"
            strokeWidth="1.2"
          />
          <path
            d="M0 390c160 34 260-26 430-8s300 36 470-8 350-34 540-4"
            stroke="var(--m-accent)"
            strokeOpacity="0.2"
            strokeWidth="1"
          />
        </g>
      </svg>
    </div>
  );
}
