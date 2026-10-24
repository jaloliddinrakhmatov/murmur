"use client";

import { useRef } from "react";
import { Icon } from "../icons.tsx";
import { Ambient } from "./ambient.tsx";
import { Heading } from "./heading.tsx";
import { NO_PREF, ScrollTrigger, gsap, useGSAP } from "./motion.ts";
import "./tone.css";
import "./notetaker.css";

const LINES = [
  { who: "You", text: "Let's lock the launch date for the twelfth." },
  { who: "Others", text: "That works if design signs off on Monday." },
  { who: "You", text: "I'll confirm with them today." },
] as const;

const SUMMARY = [
  "Launch date: the twelfth",
  "Design sign-off needed on Monday",
  "Next: you confirm with design today",
];

const PROMISES = [
  "Records only after you press Start, with a visible indicator",
  "Audio is deleted once the transcript is saved",
  "Summaries are written on request, after you consent to the AI service",
];

export function Notetaker() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        const q = gsap.utils.selector(el);
        const strokes = q(".nt-draw");
        const arcsYou = q(".nt-arcs-you path");
        const arcsOthers = q(".nt-arcs-others path");
        const rec = q(".nt-rec")[0];
        const lines = q(".nt-line");
        const words = lines.map((l) => l.querySelectorAll(".nt-w"));
        const sumHead = q(".nt-sum-h")[0];
        const bullets = q(".nt-bullet");
        const checks = q(".nt-bullet svg path");
        const bwords = q(".nt-bullet .nt-bt");

        gsap.set(strokes, { drawSVG: "0%" });
        gsap.set([arcsYou, arcsOthers], { drawSVG: "0%", opacity: 1 });
        gsap.set(rec, { scale: 0, transformOrigin: "50% 50%" });
        gsap.set(lines, { opacity: 0, y: 12 });
        gsap.set(sumHead, { opacity: 0 });
        gsap.set(bullets, { opacity: 0 });
        gsap.set(checks, { drawSVG: "0%" });

        const speak = (tl: gsap.core.Timeline, arcs: Element[], t: number) => {
          tl.fromTo(
            arcs,
            { drawSVG: "0% 0%", opacity: 1 },
            {
              drawSVG: "0% 100%",
              duration: 0.5,
              stagger: 0.12,
              ease: "power2.out",
            },
            t,
          );
          tl.to(arcs, { opacity: 0.25, duration: 0.6 }, t + 1.2);
        };

        const tl = gsap.timeline({
          paused: true,
          defaults: { ease: "power2.inOut" },
        });
        tl.to(strokes, { drawSVG: "100%", duration: 1.1, stagger: 0.08 }, 0.1);
        tl.to(rec, { scale: 1, duration: 0.5, ease: "back.out(3)" }, 1.2);
        // Three turns of conversation: the speaker's sound lines, then the words.
        const turns: [Element[], number][] = [
          [arcsYou, 1.9],
          [arcsOthers, 4.1],
          [arcsYou, 6.1],
        ];
        turns.forEach(([arcs, t], i) => {
          speak(tl, arcs, t);
          tl.to(lines[i], { opacity: 1, y: 0, duration: 0.4 }, t + 0.1);
          tl.fromTo(
            words[i],
            { opacity: 0.12 },
            { opacity: 1, duration: 0.2, stagger: 0.09, ease: "none" },
            t + 0.3,
          );
        });
        tl.to(sumHead, { opacity: 1, duration: 0.4 }, 8.3);
        bullets.forEach((b, i) => {
          const t = 8.7 + i * 0.7;
          tl.to(b, { opacity: 1, duration: 0.3 }, t);
          tl.to(checks[i], { drawSVG: "100%", duration: 0.4 }, t + 0.05);
          tl.fromTo(
            bwords[i],
            { clipPath: "inset(0 100% 0 0)" },
            { clipPath: "inset(0 0% 0 0)", duration: 0.6, ease: "none" },
            t + 0.1,
          );
        });
        // The recording dot keeps a slow pulse while the card is on screen.
        tl.to(
          rec,
          {
            scale: 0.75,
            duration: 0.8,
            yoyo: true,
            repeat: 5,
            ease: "sine.inOut",
          },
          3,
        );

        ScrollTrigger.create({
          trigger: el.querySelector(".nt-card"),
          start: "top 70%",
          once: true,
          onEnter: () => tl.play(),
        });
        return () => {
          tl.kill();
        };
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section id="notetaker" ref={root} className="tone-night nt py-28 sm:py-40">
      <Ambient />
      <div className="container-m">
        <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <Heading
              eyebrow="Notetaker"
              tone="night"
              align="left"
              sub="Press Start and Murmur transcribes your microphone and your Mac's sound, labelling who said what. Type your own notes alongside. Ask for a summary when you want one."
            >
              Be in the meeting, <em>not the notes</em>
            </Heading>
            <ul className="mt-8 space-y-3">
              {PROMISES.map((t) => (
                <li key={t} className="flex gap-3 text-night-fg" data-rv>
                  <Icon
                    name="check"
                    size={20}
                    className="mt-0.5 shrink-0 text-accent-text"
                  />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div
            className="nt-card"
            aria-label="Example of a meeting, its transcript and summary"
          >
            <div className="nt-card-h">
              <p>
                <i className="nt-dot" />
                Launch sync
              </p>
              <span className="nt-tag">Example</span>
            </div>

            <svg
              viewBox="0 0 480 190"
              className="nt-art"
              role="img"
              aria-label="Two people on either side of a laptop with a recording light; sound lines travel from each of them to the laptop."
            >
              <g className="nt-line-art">
                <circle className="nt-draw" cx="84" cy="62" r="20" />
                <path className="nt-draw" d="M44 152 C44 108 124 108 124 152" />
                <circle className="nt-draw" cx="396" cy="62" r="20" />
                <path
                  className="nt-draw"
                  d="M356 152 C356 108 436 108 436 152"
                />
                <path className="nt-draw" d="M18 152 H462" />
                <rect
                  className="nt-draw"
                  x="200"
                  y="86"
                  width="80"
                  height="50"
                  rx="7"
                />
                <path className="nt-draw" d="M186 142 H294" />
              </g>
              <circle className="nt-rec" cx="240" cy="111" r="5" />
              <g className="nt-arcs nt-arcs-you">
                <path d="M126 58 q12 12 0 24" />
                <path d="M140 50 q20 20 0 40" />
                <path d="M154 42 q28 28 0 56" />
              </g>
              <g className="nt-arcs nt-arcs-others">
                <path d="M354 58 q-12 12 0 24" />
                <path d="M340 50 q-20 20 0 40" />
                <path d="M326 42 q-28 28 0 56" />
              </g>
              <text x="84" y="176" textAnchor="middle" className="nt-lbl">
                You
              </text>
              <text x="396" y="176" textAnchor="middle" className="nt-lbl">
                Others
              </text>
            </svg>

            <ul className="nt-lines">
              {LINES.map((l, i) => (
                <li
                  key={i}
                  className={`nt-line ${l.who === "You" ? "nt-you" : "nt-others"}`}
                >
                  <span className="nt-who">{l.who}</span>
                  <span className="nt-bubble">
                    {l.text.split(" ").map((w, n) => (
                      <span key={n} className="nt-w">
                        {w}{" "}
                      </span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>

            <div className="nt-sum">
              <p className="nt-sum-h">
                <b>Summary</b>
                <span>on request</span>
              </p>
              <ul>
                {SUMMARY.map((s) => (
                  <li key={s} className="nt-bullet">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                    <span className="nt-bt">{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
