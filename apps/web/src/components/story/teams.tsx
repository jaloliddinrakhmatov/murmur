"use client";

import Link from "next/link";
import { TEAM_POINTS } from "../../content/sections.ts";
import { Icon } from "../icons.tsx";
import { Heading } from "./heading.tsx";
import { gsap, useLoop } from "./motion.ts";
import "./teams.css";

type Row = { word: string; by: "You" | "Teammate"; slot: boolean };
const ROWS: Row[] = [
  { word: "Murmur", by: "You", slot: false },
  { word: "Notetaker", by: "Teammate", slot: false },
  { word: "Kubernetes", by: "Teammate", slot: true },
  { word: "Q4 roadmap", by: "You", slot: true },
  { word: "Samarkand", by: "Teammate", slot: true },
];
const ROW_H = 56;

function Cursor({
  who,
  x,
  y,
}: {
  who: "You" | "Teammate";
  x: number;
  y: number;
}) {
  return (
    <div
      className={`tm-cursor tm-cursor-${who === "You" ? "you" : "mate"}`}
      style={{ transform: `translate(${x}px, ${y}px)` }}
    >
      <svg viewBox="0 0 16 20" width="16" height="20" aria-hidden="true">
        <path d="M1.5 1.5v14l3.8-3.4 2.7 6 2.6-1.2-2.7-5.9 5.1-.2L1.5 1.5Z" />
      </svg>
      <span>{who}</span>
    </div>
  );
}

function TeamDictionary() {
  const ref = useLoop((tl, root) => {
    const q = gsap.utils.selector(root);
    const you = q(".tm-cursor-you")[0];
    const mate = q(".tm-cursor-mate")[0];
    const count = q(".tm-count")[0];
    const slots = q(".tm-row[data-slot]");
    const proxy = { n: 2 };
    const show = () => (count.textContent = String(Math.round(proxy.n)));

    const plan: { cursor: Element; row: number; t: number }[] = [
      { cursor: mate, row: 2, t: 0.6 },
      { cursor: you, row: 3, t: 3.6 },
      { cursor: mate, row: 4, t: 6.6 },
    ];
    tl.set(
      slots.map((s) => s.querySelector(".tm-filled")),
      { opacity: 0 },
      0,
    );
    tl.set(
      slots.map((s) => s.querySelector(".tm-empty")),
      { opacity: 1 },
      0,
    );
    tl.set(
      slots.flatMap((s) => Array.from(s.querySelectorAll(".tm-ch"))),
      { opacity: 0 },
      0,
    );
    tl.set([you, mate], { opacity: 0, x: 280, y: 250 }, 0);
    tl.set(proxy, { n: 2 }, 0);
    plan.forEach(({ cursor, row, t }, i) => {
      const slot = slots[i];
      const filled = slot.querySelector(".tm-filled");
      const empty = slot.querySelector(".tm-empty");
      const chars = slot.querySelectorAll(".tm-ch");
      const ring = slot.querySelector(".tm-click");
      tl.to(cursor, { opacity: 1, duration: 0.3 }, t);
      tl.to(
        cursor,
        { x: 150, y: row * ROW_H + 26, duration: 1.2, ease: "power3.inOut" },
        t,
      );
      tl.fromTo(
        ring,
        { scale: 0.4, opacity: 0.9 },
        { scale: 1.6, opacity: 0, duration: 0.5 },
        t + 1.25,
      );
      tl.to(empty, { opacity: 0, duration: 0.2 }, t + 1.35);
      tl.set(filled, { opacity: 1 }, t + 1.35);
      tl.to(
        chars,
        { opacity: 1, duration: 0.05, stagger: 0.07, ease: "none" },
        t + 1.4,
      );
      tl.to(
        proxy,
        { n: 3 + i, duration: 0.3, onUpdate: show, ease: "none" },
        t + 1.4 + chars.length * 0.07,
      );
      tl.to(
        cursor,
        { x: 320, y: row * ROW_H + 70, duration: 1, ease: "power2.inOut" },
        t + 2.2 + chars.length * 0.07,
      );
    });
    tl.to([you, mate], { opacity: 0, duration: 0.4 }, 10);
    tl.to({}, { duration: 0.6 }, 10.4);
  }, 0.5);

  return (
    <div ref={ref} className="tm-dict">
      <div className="tm-head">
        <p>
          <b>Team dictionary</b>
          <span>
            <b className="tm-count">{ROWS.length}</b> words
          </span>
        </p>
        <span className="tm-ill">Illustration · planned</span>
      </div>
      <div className="tm-list" aria-hidden="true">
        <ul>
          {ROWS.map((r) => (
            <li
              key={r.word}
              className="tm-row"
              data-slot={r.slot ? "" : undefined}
            >
              {r.slot && (
                <span className="tm-empty">
                  <Icon name="pen" size={14} /> Add a word
                </span>
              )}
              <span className="tm-filled">
                <span className="tm-word">
                  {r.word.split("").map((c, i) => (
                    <span key={i} className="tm-ch">
                      {c === " " ? " " : c}
                    </span>
                  ))}
                </span>
                <span className={`tm-by ${r.by === "You" ? "tm-by-you" : ""}`}>
                  {r.by}
                </span>
              </span>
              {r.slot && <i className="tm-click" />}
            </li>
          ))}
        </ul>
        <Cursor who="Teammate" x={250} y={4 * ROW_H + 40} />
        <Cursor who="You" x={190} y={3 * ROW_H + 38} />
      </div>
    </div>
  );
}

export function Teams() {
  return (
    <section id="teams" className="container-m py-24 sm:py-32">
      <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.05fr]">
        <div>
          <Heading
            eyebrow="Better together"
            align="left"
            sub="Create a team, invite the people you work with, and share a plan. Everyone keeps their own library on their own Mac."
          >
            Murmur is quieter with <em>your team</em>
          </Heading>
          <ul className="mt-9 grid gap-6">
            {TEAM_POINTS.map((p) => (
              <li key={p.title} className="flex gap-4" data-rv>
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-faint text-accent-text">
                  <Icon name={p.icon} />
                </span>
                <span>
                  <b className="block text-lg">{p.title}</b>
                  <span className="mt-1 block leading-relaxed text-muted">
                    {p.body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-sm leading-relaxed text-muted" data-rv>
            On the roadmap: a dictionary and snippets your whole team shares, as
            pictured. It is not in the app yet.{" "}
            <Link
              href="/pricing"
              className="font-semibold text-accent-text underline underline-offset-4"
            >
              See plans
            </Link>
          </p>
        </div>
        <div className="tm-wrap" data-rv>
          <TeamDictionary />
        </div>
      </div>
    </section>
  );
}
