"use client";

import { useRef } from "react";
import { PERSONAS } from "../../content/sections.ts";
import { Heading } from "./heading.tsx";
import { NO_PREF, gsap, useGSAP } from "./motion.ts";
import "./personas.css";

const PIN =
  "(min-width: 1024px) and (min-height: 780px) and (prefers-reduced-motion: no-preference)";
const FLOW =
  "not all and (min-width: 1024px) and (min-height: 780px) and (prefers-reduced-motion: no-preference)";

/** Line scenes, one per kind of work. Every stroke is a .d path so it can draw itself. */
function Scene({ kind }: { kind: (typeof PERSONAS)[number]["scene"] }) {
  switch (kind) {
    case "writers":
      return (
        <>
          <rect className="d" x="66" y="14" width="108" height="112" rx="10" />
          <path className="d" d="M86 44h68M86 62h56M86 80h68M86 98h34" />
          <path className="d p" d="M170 98 196 72l10 10-26 26-14 4 4-14Z" />
          <path className="d p" d="m190 78 10 10" />
        </>
      );
    case "developers":
      return (
        <>
          <rect className="d" x="30" y="16" width="180" height="108" rx="12" />
          <path className="d" d="M30 40h180" />
          <path className="d" d="m52 66-12 10 12 10M188 66l12 10-12 10" />
          <rect className="d p" x="68" y="62" width="76" height="24" rx="12" />
          <text className="t" x="106" y="78" textAnchor="middle">
            @auth.ts
          </text>
          <path className="d" d="M152 74h22M68 102h92" />
        </>
      );
    case "support":
      return (
        <>
          <path
            className="d"
            d="M44 24h100a14 14 0 0 1 14 14v10a14 14 0 0 1-14 14H70l-18 14V62a14 14 0 0 1-8-14V38a14 14 0 0 1 14-14Z"
          />
          <path className="d" d="M64 40h72M64 52h40" />
          <path
            className="d p"
            d="M96 80h100a14 14 0 0 1 14 14v6a14 14 0 0 1-14 14h-14l-16 14v-14H96a14 14 0 0 1-14-14v-6a14 14 0 0 1 14-14Z"
          />
          <path className="d" d="M102 92h86M102 104h46" />
        </>
      );
    case "students":
      return (
        <>
          <path
            className="d"
            d="M120 36C100 24 62 24 36 34v74c26-10 64-10 84 2 20-12 58-12 84-2V34c-26-10-64-10-84 2Z"
          />
          <path className="d" d="M120 36v74" />
          <path
            className="d"
            d="M54 52c14-4 28-3 52 4M54 68c14-4 28-3 52 4M134 56c24-7 38-8 52-4M134 72c24-7 38-8 52-4"
          />
          <circle className="d p" cx="198" cy="26" r="9" />
          <path className="d p" d="M198 21v10M193 26h10" />
        </>
      );
    default:
      return (
        <>
          <circle className="d" cx="60" cy="36" r="11" />
          <path className="d" d="M40 70c0-24 40-24 40 0" />
          <circle className="d" cx="120" cy="30" r="11" />
          <path className="d" d="M100 64c0-24 40-24 40 0" />
          <circle className="d" cx="180" cy="36" r="11" />
          <path className="d" d="M160 70c0-24 40-24 40 0" />
          <path className="d" d="M24 76h192" />
          <path className="d p" d="m52 96 6 6 10-12M52 116l6 6 10-12" />
          <path className="d" d="M84 98h92M84 118h64" />
        </>
      );
  }
}

export function BuiltFor() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const view = el.querySelector<HTMLElement>(".pg-view")!;
      const track = el.querySelector<HTMLElement>(".pg-track")!;
      const pinEl = el.querySelector<HTMLElement>(".pg-pin")!;
      const prog = el.querySelector<HTMLElement>(".pg-prog i")!;
      const cards = gsap.utils.toArray<HTMLElement>(".pg-card", el);
      const mm = gsap.matchMedia();

      // Each scene draws itself the first time most of its card is visible in the gallery.
      const arm = () => {
        const tls = cards.map((card) => {
          const strokes = card.querySelectorAll(".d");
          const texts = card.querySelectorAll(".t");
          gsap.set(strokes, { drawSVG: "0%" });
          if (texts.length) gsap.set(texts, { opacity: 0 });
          const tl = gsap.timeline({
            paused: true,
            defaults: { ease: "power2.inOut" },
          });
          tl.to(
            strokes,
            { drawSVG: "100%", duration: 0.9, stagger: 0.12 },
            0.1,
          );
          if (texts.length) tl.to(texts, { opacity: 1, duration: 0.4 }, 0.8);
          return tl;
        });
        const io = new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const i = cards.indexOf(e.target as HTMLElement);
              tls[i]?.play();
              io.unobserve(e.target);
            }
          },
          { root: view, threshold: 0.55 },
        );
        cards.forEach((c) => io.observe(c));
        return () => {
          io.disconnect();
          tls.forEach((t) => t.kill());
        };
      };

      mm.add(PIN, () => {
        const stopArm = arm();
        const dist = () => Math.max(0, track.scrollWidth - view.clientWidth);
        gsap
          .timeline({
            defaults: { ease: "none" },
            scrollTrigger: {
              trigger: pinEl,
              start: "top top+=64",
              end: () => "+=" + Math.round(dist() * 1.15),
              pin: true,
              scrub: 0.6,
              anticipatePin: 1,
              invalidateOnRefresh: true,
            },
          })
          .to(track, { x: () => -dist() }, 0)
          .to(prog, { scaleX: 1 }, 0);
        return stopArm;
      });

      mm.add(FLOW, () => {
        // With reduced motion the scenes stay drawn; only the progress bar follows the scroll.
        const stopArm = window.matchMedia(NO_PREF).matches ? arm() : () => {};
        const onScroll = () => {
          const max = view.scrollWidth - view.clientWidth;
          gsap.set(prog, { scaleX: max > 0 ? view.scrollLeft / max : 1 });
        };
        view.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
        return () => {
          view.removeEventListener("scroll", onScroll);
          stopArm();
        };
      });

      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section id="built-for" ref={root} className="pg">
      <div className="pg-pin">
        <div className="container-m">
          <Heading
            eyebrow="Built for"
            sub="Examples of how people might use Murmur. These are written by us, not customer quotes."
          >
            Made for people who <em>think out loud</em>
          </Heading>
        </div>
        <div
          className="pg-view"
          role="region"
          aria-label="Examples of who Murmur is for"
          tabIndex={0}
        >
          <ul className="pg-track">
            {PERSONAS.map((p) => (
              <li key={p.who} className="pg-card card">
                <svg
                  viewBox="0 0 240 140"
                  className="pg-scene"
                  aria-hidden="true"
                >
                  <Scene kind={p.scene} />
                </svg>
                <h3>{p.who}</h3>
                <p className="pg-line">{p.line}</p>
                <p className="pg-ex">{p.example}</p>
              </li>
            ))}
          </ul>
        </div>
        <div className="container-m">
          <div className="pg-prog" aria-hidden="true">
            <i />
          </div>
        </div>
      </div>
    </section>
  );
}
