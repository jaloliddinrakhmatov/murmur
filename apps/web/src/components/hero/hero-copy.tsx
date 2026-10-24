"use client";

import Link from "next/link";
import { useRef } from "react";
import { HERO } from "../../content/hero.ts";
import { gsap } from "../../motion/gsap.ts";
import { Magnetic } from "../../motion/magnetic.tsx";
import { useMotion } from "../../motion/use-motion.ts";
import { SIGNATURE_PATHS, SIGNATURE_VIEWBOX } from "./signature.ts";
import "./hero.css";

function Words({ text }: { text: string }) {
  const list = text.split(" ");
  return list.map((word, i) => (
    <span key={`${word}-${i}`}>
      <span className="hw">
        <span className="hw-in">{word}</span>
      </span>
      {i < list.length - 1 ? " " : null}
    </span>
  ));
}

/**
 * Hero text. The headline is real text in masks: the words rise out one by one, and "Murmur" is
 * written by hand: its outline (traced from the font) draws itself with DrawSVG, then the letters
 * fill in. Server HTML is the finished state; JS rewinds it just before first paint.
 */
export function HeroCopy() {
  const root = useRef<HTMLDivElement>(null);

  useMotion(() => {
    const el = root.current;
    if (!el) return;
    const q = gsap.utils.selector(el);
    const h1 = el.querySelector<HTMLElement>("h1");
    const words = q(".hw-in").filter((w) => !w.closest("[data-signed]"));
    const signed = el.querySelector<HTMLElement>("[data-signed] em");
    const strokes = q(".signature path");
    const rest = q("[data-hero-rest]");

    gsap.set(words, { yPercent: 115, rotate: 4 });
    gsap.set(signed, { opacity: 0 });
    gsap.set(strokes, { drawSVG: "0%", opacity: 1 });
    gsap.set(rest, { opacity: 0, y: 18 });
    for (const node of [h1, ...q("[data-eyebrow]"), ...rest])
      node?.setAttribute("data-m-set", "");

    const tl = gsap.timeline({ delay: 0.15, defaults: { ease: "expo.out" } });
    tl.from(q("[data-eyebrow]"), { opacity: 0, y: 10, duration: 0.9 }, 0);
    tl.to(
      words.slice(0, 3),
      { yPercent: 0, rotate: 0, duration: 1.2, stagger: 0.08 },
      0.1,
    );
    tl.to(
      strokes,
      { drawSVG: "100%", duration: 1.5, stagger: 0.12, ease: "power2.inOut" },
      0.45,
    );
    tl.to(signed, { opacity: 1, duration: 0.9, ease: "power1.out" }, 1.75);
    tl.to(strokes, { opacity: 0, duration: 0.9, ease: "power1.out" }, 1.85);
    tl.to(
      words.slice(3),
      { yPercent: 0, rotate: 0, duration: 1.2, stagger: 0.08 },
      1.2,
    );
    tl.to(
      rest,
      {
        opacity: 1,
        y: 0,
        duration: 1,
        stagger: 0.1,
        clearProps: "opacity,transform",
      },
      1.0,
    );
  }, root);

  return (
    <div ref={root}>
      <p className="eyebrow" data-eyebrow data-m-hide="">
        {HERO.eyebrow}
      </p>
      <h1
        className="display mx-auto mt-4 max-w-4xl text-[clamp(2.9rem,8vw,5.6rem)]"
        data-m-hide=""
      >
        <Words text={HERO.titleStart} />{" "}
        <span className="hw" data-signed>
          <span className="hw-in relative">
            <em>{HERO.titleAccent}</em>
            <svg
              className="signature"
              viewBox={SIGNATURE_VIEWBOX}
              aria-hidden="true"
              focusable="false"
            >
              {SIGNATURE_PATHS.map((d, i) => (
                <path key={i} d={d} />
              ))}
            </svg>
          </span>
        </span>{" "}
        <Words text={HERO.titleEnd} />
      </h1>
      <p
        className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted sm:text-xl"
        data-hero-rest
        data-m-hide=""
      >
        {HERO.sub}
      </p>
      <div
        className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
        data-hero-rest
        data-m-hide=""
      >
        <Magnetic>
          <Link href={HERO.primary.href} className="btn btn-primary">
            {HERO.primary.label}
          </Link>
        </Magnetic>
        <a href={HERO.secondary.href} className="btn btn-ghost">
          {HERO.secondary.label}
        </a>
      </div>
      <p className="mt-4 text-sm text-muted" data-hero-rest data-m-hide="">
        {HERO.note}
      </p>
    </div>
  );
}
