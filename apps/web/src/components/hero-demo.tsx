"use client";

import { useEffect, useRef, useState } from "react";
import { DEMO_SCRIPTS } from "../content/hero.ts";
import { finalFrame, frameAt, totalMs, words } from "../lib/demo.ts";
import { gsap } from "../motion/gsap.ts";
import { useInView } from "../motion/use-in-view.ts";
import { useMotion } from "../motion/use-motion.ts";
import { voiceSignal } from "../motion/voice-signal.ts";
import "./hero/hero.css";

const TICK_MS = 70;
const INTRO_HOLD_MS = 4500;
const BARS = [0.5, 0.9, 0.65, 1, 0.7, 0.95, 0.55, 0.8, 0.45];
const VOICE_BARS = [0.3, 0.55, 0.8, 0.45, 1, 0.65, 0.9, 0.5, 0.75, 0.35, 0.6];

/**
 * Animated mock: a spoken sentence becomes typed text in an app window, shown as a small 3D scene.
 * The window tilts towards you as it scrolls into view and leans with the pointer; the Capsule,
 * the style chip and the voice card float at different depths. Static (and flat) when motion is
 * reduced, and the first paint already shows the finished sentence.
 */
export function HeroDemo() {
  const [index, setIndex] = useState(0);
  const [t, setT] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const tilt = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const inView = useInView(stage, "200px 0px");
  const script = DEMO_SCRIPTS[index];

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // First paint shows the finished sentence; the loop starts after a pause.
    const id = window.setTimeout(() => setT(0), INTRO_HOLD_MS);
    return () => window.clearTimeout(id);
  }, []);

  const running = t !== null && inView;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setT((current) => (current ?? 0) + TICK_MS);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (t !== null && t >= totalMs(script)) {
      setIndex((i) => (i + 1) % DEMO_SCRIPTS.length);
      setT(0);
    }
  }, [t, script]);

  const frame = t === null ? finalFrame(script) : frameAt(script, t);
  const spoken = words(script.spoken).slice(0, frame.spokenCount).join(" ");
  const written = words(script.written).slice(0, frame.writtenCount).join(" ");
  const listening = frame.phase === "listen";
  const label =
    frame.phase === "listen"
      ? "Listening"
      : frame.phase === "think"
        ? "Tidying up"
        : frame.phase === "write"
          ? "Writing"
          : "Done";

  useEffect(() => {
    voiceSignal.set(listening ? 1 : 0);
  }, [listening]);
  useEffect(() => () => voiceSignal.set(0), []);

  // Scroll tilt (scrubbed) and pointer lean, on two nested 3D layers.
  useMotion(() => {
    const tiltEl = tilt.current;
    const sceneEl = scene.current;
    if (!tiltEl || !sceneEl) return;

    gsap.fromTo(
      tiltEl,
      { rotationX: 20, y: 36, scale: 0.94, transformOrigin: "50% 100%" },
      {
        rotationX: 0,
        y: 0,
        scale: 1,
        ease: "none",
        scrollTrigger: {
          trigger: stage.current,
          start: "top 105%",
          end: "top 38%",
          scrub: 0.6,
        },
      },
    );

    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches)
      return;
    const rx = gsap.quickTo(sceneEl, "rotationX", {
      duration: 1,
      ease: "power3.out",
    });
    const ry = gsap.quickTo(sceneEl, "rotationY", {
      duration: 1,
      ease: "power3.out",
    });
    const onMove = (e: PointerEvent) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      ry(nx * 9);
      rx(-ny * 5);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, stage);

  return (
    <div
      ref={stage}
      className="stage relative mx-auto w-full max-w-3xl pb-12"
      data-active={inView}
      role="img"
      aria-label={`Demo: spoken words become written text in ${script.app}.`}
    >
      <div ref={tilt} className="stage-tilt">
        <div ref={scene} className="stage-scene relative">
          <div
            className="pointer-events-none absolute -inset-x-16 -top-20 -bottom-12 rounded-[3rem]"
            style={{
              transform: "translateZ(-80px)",
              background:
                "radial-gradient(60% 60% at 50% 45%, var(--m-glow), transparent 70%)",
            }}
          />
          <div
            className="overflow-hidden rounded-2xl bg-modal shadow-window"
            aria-hidden="true"
          >
            <div className="flex items-center gap-2 border-b border-hairline bg-surface px-4 py-3">
              <span className="size-3 rounded-full bg-hairline-strong" />
              <span className="size-3 rounded-full bg-hairline-strong" />
              <span className="size-3 rounded-full bg-hairline-strong" />
              <span className="ml-3 text-sm font-semibold text-muted">
                {script.app}
              </span>
              <span className="ml-auto rounded-full bg-accent-faint px-2.5 py-0.5 text-xs font-semibold text-accent-text md:hidden">
                {script.style}
              </span>
            </div>
            <div className="min-h-44 px-6 py-6 text-left sm:min-h-52 sm:px-9 sm:py-8">
              <p className="font-serif text-2xl leading-snug sm:text-[1.7rem]">
                {written}
                <span className="caret ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-1 bg-accent" />
              </p>
            </div>
            <div className="border-t border-hairline bg-surface/70 px-6 py-3 text-sm text-muted sm:px-9">
              <span className="font-semibold">You say</span>{" "}
              <span className="italic">{spoken ? `“${spoken}”` : "…"}</span>
            </div>
          </div>

          <div
            className="stage-layer top-14 -right-10 hidden md:block"
            style={{ transform: "translateZ(90px)" }}
            aria-hidden="true"
          >
            <div
              className="float glass flex items-center gap-2 rounded-full py-2 pr-4 pl-3"
              style={{ animationDuration: "8s" }}
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="var(--m-accent-text)"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z" />
              </svg>
              <span className="text-sm font-semibold">{script.style}</span>
            </div>
          </div>

          <div
            className="stage-layer top-[38%] -left-16 hidden md:block"
            style={{ transform: "translateZ(130px)" }}
            aria-hidden="true"
          >
            <div
              className="float glass rounded-2xl px-4 py-3"
              style={{ animationDuration: "9s", animationDelay: "-3s" }}
            >
              <p className="text-left text-xs font-semibold text-muted">
                Your voice
              </p>
              <span className="mt-2 flex h-8 items-center gap-[3px]">
                {VOICE_BARS.map((h, i) => (
                  <span
                    key={i}
                    className={listening ? "wave-bar" : ""}
                    style={{
                      width: 3,
                      height: `${h * 32}px`,
                      borderRadius: 2,
                      background: listening
                        ? "var(--m-accent)"
                        : "var(--m-hairline-strong)",
                      ["--d" as string]: `${i * 70}ms`,
                      transform: listening ? undefined : "scaleY(0.25)",
                      transition: "background-color 400ms",
                    }}
                  />
                ))}
              </span>
            </div>
          </div>

          <div
            className="stage-layer inset-x-0 -bottom-9 z-10 flex justify-center"
            style={{ transform: "translateZ(60px)" }}
            aria-hidden="true"
          >
            <div className="float glass flex items-center gap-3 rounded-full py-2 pr-4 pl-3">
              <svg viewBox="0 0 24 24" width="24" height="24">
                <rect
                  x="2"
                  y="7"
                  width="20"
                  height="10"
                  rx="5"
                  fill="var(--m-fg)"
                />
                <circle cx="16" cy="12" r="2.1" fill="var(--m-accent)" />
              </svg>
              <span className="flex h-5 items-center gap-[3px]">
                {BARS.map((h, i) => (
                  <span
                    key={i}
                    className={listening ? "wave-bar" : ""}
                    style={{
                      width: 3,
                      height: `${h * 20}px`,
                      borderRadius: 2,
                      background: listening
                        ? "var(--m-accent)"
                        : "var(--m-hairline-strong)",
                      ["--d" as string]: `${i * 90}ms`,
                      transform: listening ? undefined : "scaleY(0.3)",
                    }}
                  />
                ))}
              </span>
              <span className="w-20 text-sm font-semibold">{label}</span>
              <span className="hidden items-center gap-1 sm:flex">
                <kbd className="keycap" data-down={listening}>
                  ⌃
                </kbd>
                <kbd className="keycap" data-down={listening}>
                  ⌥
                </kbd>
                <kbd className="keycap" data-down={listening}>
                  Space
                </kbd>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
