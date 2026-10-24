"use client";

import { useRef } from "react";
import {
  SPEAKING_WPM,
  TYPING_WPM,
  formatDuration,
  secondsFor,
  speedup,
} from "../../lib/speed.ts";
import { Icon } from "../icons.tsx";
import { NO_PREF, ScrollTrigger, gsap, useGSAP } from "./motion.ts";
import "./speed-race.css";

const WORDS = 150;

export function SpeedRace() {
  const root = useRef<HTMLElement>(null);
  const play = useRef<(() => void) | null>(null);
  const typing = secondsFor(WORDS, TYPING_WPM);
  const speaking = secondsFor(WORDS, SPEAKING_WPM);
  const share = speaking / typing;
  const x = speedup();

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        const q = gsap.utils.selector(el);
        const bars = q(".sr-fill");
        const counts = q(".sr-count");
        const dones = q(".sr-done");
        const big = q(".sr-big")[0];
        const clock = q(".sr-clock")[0];
        const proxy = { clock: 0, big: 1, speak: 0, type: 0 };
        const fmt = () => {
          counts[0].textContent = String(Math.round(proxy.speak));
          counts[1].textContent = String(Math.round(proxy.type));
          clock.textContent = formatDuration(Math.round(proxy.clock));
          big.textContent = proxy.big.toFixed(1);
        };
        const build = () => {
          const RUN = 6.8;
          const tl = gsap.timeline({ paused: true });
          tl.set(bars, { scaleX: 0 }, 0);
          tl.set(dones, { opacity: 0, y: 6 }, 0);
          tl.to(
            proxy,
            { big: x, duration: 1.6, ease: "power2.out", onUpdate: fmt },
            0,
          );
          tl.to(
            proxy,
            { clock: typing, duration: RUN, ease: "none", onUpdate: fmt },
            0,
          );
          tl.to(
            proxy,
            { type: WORDS, duration: RUN, ease: "none", onUpdate: fmt },
            0,
          );
          tl.to(
            proxy,
            {
              speak: WORDS,
              duration: RUN * share,
              ease: "none",
              onUpdate: fmt,
            },
            0,
          );
          tl.to(
            bars[0],
            { scaleX: share, duration: RUN * share, ease: "none" },
            0,
          );
          tl.to(bars[1], { scaleX: 1, duration: RUN, ease: "none" }, 0);
          tl.to(dones[0], { opacity: 1, y: 0, duration: 0.4 }, RUN * share);
          tl.to(dones[1], { opacity: 1, y: 0, duration: 0.4 }, RUN);
          return tl;
        };
        // The first play happens when the card is mostly in view; a button repeats it.
        let tl = build();
        ScrollTrigger.create({
          trigger: el.querySelector(".sr-card"),
          start: "top 72%",
          once: true,
          onEnter: () => tl.play(0),
        });
        play.current = () => {
          tl.kill();
          proxy.clock = proxy.big = proxy.speak = proxy.type = 0;
          tl = build();
          tl.play(0);
        };
        return () => {
          play.current = null;
          tl.kill();
        };
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const rows = [
    {
      key: "speak",
      label: "Speaking",
      wpm: SPEAKING_WPM,
      secs: speaking,
      pct: share * 100,
      accent: true,
    },
    {
      key: "type",
      label: "Typing",
      wpm: TYPING_WPM,
      secs: typing,
      pct: 100,
      accent: false,
    },
  ];

  return (
    <section id="speed" ref={root} className="container-m sr py-20 sm:py-28">
      <div className="card sr-card">
        <div className="sr-head">
          <div>
            <p className="eyebrow" data-rv>
              The speed of thought
            </p>
            <h2 className="display mt-3 text-3xl sm:text-5xl" data-rv>
              Speaking is about{" "}
              <em>
                <span className="sr-big">{x.toFixed(1)}</span>×
              </em>{" "}
              faster than typing
            </h2>
            <p className="mt-4 text-muted" data-rv>
              Time to write a {WORDS}-word message, using typical estimates.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost sr-replay"
            onClick={() => play.current?.()}
          >
            <Icon name="history" size={18} />
            Replay
          </button>
        </div>

        <p className="sr-elapsed">
          Elapsed <b className="sr-clock">{formatDuration(typing)}</b>
          <span> (the race is sped up)</span>
        </p>
        <ul className="sr-lanes">
          {rows.map((r) => (
            <li key={r.key} className="sr-lane">
              <div className="sr-meta">
                <span className="sr-name">
                  {r.label}{" "}
                  <span className="sr-wpm">
                    (about {r.wpm} words per minute)
                  </span>
                </span>
                <span className="sr-words">
                  <b className="sr-count">{WORDS}</b> words
                </span>
              </div>
              <div className="sr-track" aria-hidden="true">
                <div
                  className={`sr-fill ${r.accent ? "sr-fill-accent" : ""}`}
                  style={{ transform: `scaleX(${r.pct / 100})` }}
                />
              </div>
              <p className="sr-done">
                <Icon name="check" size={16} />
                Done in <b className="sr-time">{formatDuration(r.secs)}</b>
              </p>
            </li>
          ))}
        </ul>
        <p className="sr-note">
          Typical estimates for an average typist and a relaxed speaker, not a
          measurement of Murmur. Your speed will differ.
        </p>
      </div>
    </section>
  );
}
