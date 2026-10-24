"use client";

import { useRef } from "react";
import { APP_KINDS } from "../../content/hero.ts";
import type { IconName } from "../../content/features.ts";
import { gsap } from "../../motion/gsap.ts";
import { useInView } from "../../motion/use-in-view.ts";
import { useMotion } from "../../motion/use-motion.ts";
import { Icon } from "../icons.tsx";
import "./hero.css";

type Kind = { icon: IconName; label: string };

const ROW_ONE: Kind[] = [...APP_KINDS];
const ROW_TWO: Kind[] = [
  { icon: "doc", label: "Wikis and docs" },
  { icon: "browser", label: "Search boxes" },
  { icon: "chat", label: "Comments" },
  { icon: "code", label: "Commit messages" },
  { icon: "board", label: "Tickets" },
  { icon: "mail", label: "Replies" },
  { icon: "notes", label: "Journals" },
  { icon: "terminal", label: "Prompts" },
];

function Chip({ kind, hidden }: { kind: Kind; hidden?: boolean }) {
  return (
    <li
      aria-hidden={hidden || undefined}
      className="app-chip flex items-center gap-2.5 rounded-full bg-sheet py-2 pr-5 pl-3.5 text-[0.9375rem] font-medium shadow-card ring-1 ring-hairline"
    >
      <Icon name={kind.icon} size={20} className="text-accent-text" />
      {kind.label}
    </li>
  );
}

function Track({ kinds, hidden }: { kinds: Kind[]; hidden?: boolean }) {
  // Two copies per track keep the loop seamless on very wide screens.
  return (
    <ul className="marquee-track" aria-hidden={hidden || undefined}>
      {kinds.map((k) => (
        <Chip key={k.label} kind={k} />
      ))}
      {kinds.map((k) => (
        <Chip key={`${k.label}-2`} kind={k} hidden />
      ))}
    </ul>
  );
}

/**
 * Two rows of app kinds drifting in opposite directions. Hover or focus pauses them, the edges
 * fade, the icons draw themselves once when the strip appears and again on hover. The loop stops
 * off screen. With reduced motion it is a single, static, wrapped list.
 */
export function Marquee() {
  const root = useRef<HTMLDivElement>(null);
  const inView = useInView(root);

  useMotion(() => {
    const el = root.current;
    if (!el) return;
    const strokes = (scope: Element) =>
      scope.querySelectorAll("svg path, svg rect, svg circle");

    gsap.from(strokes(el), {
      drawSVG: 0,
      duration: 1.4,
      ease: "power2.inOut",
      stagger: 0.015,
      scrollTrigger: { trigger: el, start: "top 90%", once: true },
    });

    const over = (e: PointerEvent) => {
      const chip = (e.target as Element).closest<HTMLElement>(".app-chip");
      if (!chip || chip.dataset.drawing) return;
      chip.dataset.drawing = "1";
      gsap.fromTo(
        strokes(chip),
        { drawSVG: "0%" },
        {
          drawSVG: "100%",
          duration: 0.75,
          ease: "power2.out",
          onComplete: () => {
            delete chip.dataset.drawing;
          },
        },
      );
    };
    el.addEventListener("pointerover", over);
    return () => el.removeEventListener("pointerover", over);
  }, root);

  return (
    <div ref={root} className="mt-6 space-y-3" data-paused={!inView}>
      <div
        className="marquee"
        data-paused={!inView}
        style={{ ["--speed" as string]: "48s" }}
      >
        <Track kinds={ROW_ONE} />
        <Track kinds={ROW_ONE} hidden />
      </div>
      <div
        className="marquee"
        aria-hidden="true"
        data-paused={!inView}
        style={{ ["--speed" as string]: "58s", ["--dir" as string]: "reverse" }}
      >
        <Track kinds={ROW_TWO} hidden />
        <Track kinds={ROW_TWO} hidden />
      </div>
    </div>
  );
}
