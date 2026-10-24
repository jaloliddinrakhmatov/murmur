"use client";

import Link from "next/link";
import { useRef } from "react";
import { PRIVACY } from "../../content/sections.ts";
import { AnimIcon } from "./anim-icon.tsx";
import { Ambient } from "./ambient.tsx";
import { Heading } from "./heading.tsx";
import { gsap, useGSAP } from "./motion.ts";
import "./tone.css";
import "./privacy.css";

const DESC =
  "Line drawing. Your Mac holds a lock: your dictations, History, notes and meetings stay on it. A dashed line carries your voice only to the transcription service you choose. A line toward Murmur's servers stops with a cross: they never receive your audio.";

type Layout = "wide" | "tall";

function Diagram({ layout }: { layout: Layout }) {
  const w = layout === "wide";
  const id = `pv-mask-${layout}`;
  const route = w ? "M352 150 H618" : "M180 246 V338";
  const blocked = w
    ? "M352 236 C432 236 470 300 510 326"
    : "M320 120 H342 V486";
  const cross = w
    ? "M502 318 l16 16 M518 318 l-16 16"
    : "M334 490 l16 16 M350 490 l-16 16";
  return (
    <svg
      viewBox={w ? "0 0 960 400" : "0 -30 360 670"}
      className={`pv-svg pv-${layout}`}
      role="img"
      aria-label={DESC}
    >
      <defs>
        <mask
          id={id}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="960"
          height="700"
        >
          <path className="pv-maskline" d={route} />
        </mask>
      </defs>
      <g className="pv-line">
        {/* Your Mac */}
        <rect
          className="pv-d pv-mac"
          x={w ? 50 : 40}
          y={w ? 70 : 20}
          width={w ? 300 : 280}
          height={w ? 190 : 190}
          rx="18"
        />
        <path
          className="pv-d pv-mac"
          d={w ? "M26 268 H374 L362 292 H38 Z" : "M16 218 H344 L332 242 H28 Z"}
        />
        {/* Lock */}
        <rect
          className="pv-d pv-lock"
          x={w ? 170 : 150}
          y={w ? 150 : 100}
          width="60"
          height="50"
          rx="10"
        />
        <path
          className="pv-d pv-lock"
          d={
            w
              ? "M182 150 V136 a18 18 0 0 1 36 0 V150"
              : "M162 100 V86 a18 18 0 0 1 36 0 V100"
          }
        />
        <path
          className="pv-d pv-lock"
          d={w ? "M200 168 v14" : "M180 118 v14"}
        />
        {/* Service you choose */}
        <rect
          className="pv-d pv-svc"
          x={w ? 620 : 40}
          y={w ? 90 : 340}
          width={w ? 290 : 280}
          height="120"
          rx="20"
        />
        {/* Murmur's servers: no route */}
        <path className="pv-d pv-no" d={blocked} />
        <path className="pv-d pv-no" d={cross} />
        <rect
          className="pv-d pv-no pv-dash"
          x={w ? 600 : 40}
          y={w ? 292 : 520}
          width={w ? 310 : 280}
          height="84"
          rx="18"
        />
      </g>
      <path className="pv-route" d={route} mask={`url(#${id})`} />
      <circle
        className="pv-dot"
        r="4.5"
        cx={w ? 352 : 180}
        cy={w ? 150 : 246}
      />

      <g className="pv-text">
        <text
          className="pv-h"
          x={w ? 200 : 180}
          y={w ? 52 : 4}
          textAnchor="middle"
        >
          Your Mac
        </text>
        <text
          className="pv-s pv-t"
          x={w ? 200 : 180}
          y={w ? 232 : 166}
          textAnchor="middle"
        >
          Dictations, History, notes, meetings
        </text>
        {w ? (
          <text className="pv-s pv-t" x="485" y="132" textAnchor="middle">
            Your voice, only when you dictate
          </text>
        ) : (
          <text className="pv-s pv-t" x="196" y="284">
            <tspan x="196">Your voice, only</tspan>
            <tspan x="196" dy="20">
              when you dictate
            </tspan>
          </text>
        )}
        <text className="pv-h pv-t" x={w ? 642 : 62} y={w ? 142 : 392}>
          The service you choose
        </text>
        <text className="pv-s pv-t" x={w ? 642 : 62} y={w ? 168 : 418}>
          Transcription, and AI cleanup
        </text>
        <text className="pv-s pv-t" x={w ? 642 : 62} y={w ? 188 : 438}>
          only if you turn it on
        </text>
        <text className="pv-h pv-t" x={w ? 624 : 62} y={w ? 328 : 560}>
          Murmur&apos;s servers
        </text>
        <text className="pv-s pv-t" x={w ? 624 : 62} y={w ? 352 : 584}>
          No audio. Nothing until you sign in.
        </text>
      </g>
    </svg>
  );
}

export function Privacy() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      const build = (layout: Layout) => () => {
        const svg = el.querySelector<SVGElement>(`.pv-${layout}`);
        if (!svg) return;
        const q = gsap.utils.selector(svg);
        const mac = q(".pv-mac");
        const lock = q(".pv-lock");
        const svc = q(".pv-svc");
        const no = q(".pv-no");
        const text = q(".pv-text > *");
        const mask = q(".pv-maskline");
        const dot = q(".pv-dot");
        const wide = layout === "wide";

        gsap.set([mac, lock, svc, no], { drawSVG: "0%" });
        gsap.set(mask, { drawSVG: "0%" });
        gsap.set(text, { opacity: 0 });
        gsap.set(dot, { opacity: 0 });

        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: {
            trigger: svg,
            start: "top 85%",
            end: "bottom 50%",
            scrub: 0.8,
          },
        });
        tl.to(mac, { drawSVG: "100%", duration: 2, stagger: 0.4 }, 0);
        tl.to(text[0], { opacity: 1, duration: 0.5 }, 1.2);
        tl.to(lock, { drawSVG: "100%", duration: 1.4, stagger: 0.3 }, 2.2);
        tl.to(text[1], { opacity: 1, duration: 0.6 }, 3.4);
        tl.to(mask, { drawSVG: "100%", duration: 1.6 }, 4.2);
        tl.to(dot, { opacity: 1, duration: 0.1 }, 4.2);
        tl.to(
          dot,
          wide ? { x: 266, duration: 1.6 } : { y: 92, duration: 1.6 },
          4.2,
        );
        tl.to(text[2], { opacity: 1, duration: 0.6 }, 4.8);
        tl.to(svc, { drawSVG: "100%", duration: 1.4 }, 5.6);
        tl.to(
          [text[3], text[4], text[5]],
          { opacity: 1, duration: 0.6, stagger: 0.15 },
          6.4,
        );
        tl.to(dot, { opacity: 0, duration: 0.2 }, 5.8);
        tl.to(no, { drawSVG: "100%", duration: 1.6, stagger: 0.5 }, 7.2);
        tl.to(
          [text[6], text[7]],
          { opacity: 1, duration: 0.6, stagger: 0.15 },
          8.6,
        );
        tl.set({}, {}, 9.6);
      };
      mm.add(
        "(min-width: 900px) and (prefers-reduced-motion: no-preference)",
        build("wide"),
      );
      mm.add(
        "(max-width: 899px) and (prefers-reduced-motion: no-preference)",
        build("tall"),
      );
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section id="privacy" ref={root} className="tone-night pv py-28 sm:py-40">
      <Ambient />
      <div className="container-m">
        <Heading
          eyebrow="Privacy"
          tone="night"
          sub="What you say is yours. Here is exactly what Murmur does with it."
        >
          Private by <em>design</em>
        </Heading>

        <div className="pv-figure">
          <Diagram layout="wide" />
          <Diagram layout="tall" />
        </div>

        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {PRIVACY.map((p) => (
            <li key={p.title} className="pv-point group" data-rv>
              <AnimIcon name={p.icon} className="pv-icon" />
              <h3 className="mt-4 text-lg font-semibold">{p.title}</h3>
              <p className="mt-2 leading-relaxed text-night-muted">{p.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-10 text-center">
          <Link
            href="/privacy"
            className="font-semibold text-accent-text underline underline-offset-4"
          >
            Read the privacy page
          </Link>
        </p>
      </div>
    </section>
  );
}
