"use client";

import { useRef } from "react";
import { STEPS } from "../../content/sections.ts";
import { Icon } from "../icons.tsx";
import { Heading } from "./heading.tsx";
import { WIDE_MOTION, gsap, useGSAP } from "./motion.ts";
import "./voice-story.css";

/** The glyph in the Murmur bar: one stroke that morphs wave, spinner and check. */
const WAVE = "M3 16 C6 5 9 5 12 16 S18 27 21 16 S26 7 29 16";
const SPIN = "M16 5 A11 11 0 1 1 5 16";
const CHECK = "M8 17.5 L14 23.5 L25 10";

const EMBER = "#ff8a4c";
const GREEN = "#5fd3a4";

const TOKENS = [
  { t: "um", filler: true },
  { t: "so", clean: "So" },
  { t: "the" },
  { t: "uh", filler: true },
  { t: "review" },
  { t: "moved" },
  { t: "to" },
  { t: "friday", clean: "Friday", end: true },
] as const;

const LANDED = "So the review moved to Friday".split(" ");
const STYLES = ["Formal", "Casual", "Very casual"];
const KEYS = [
  { cap: "⌃", name: "control" },
  { cap: "⌥", name: "option" },
  { cap: "Space", name: "" },
];

export function VoiceStory() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const mm = gsap.matchMedia();
      mm.add(WIDE_MOTION, () => {
        const q = gsap.utils.selector(el);
        const one = <T extends Element>(s: string) => q(s)[0] as unknown as T;
        const pin = one<HTMLElement>(".vs-pin");
        const box = one<HTMLElement>(".vs-stagebox");
        const canvas = one<HTMLCanvasElement>(".vs-canvas");
        const cap = one<HTMLElement>(".vs-cap");
        const waveWrap = one<HTMLElement>(".vs-cap-wave");
        const glyph = one<SVGElement>(".vs-glyph");
        const glyphPath = one<SVGPathElement>(".vs-glyph path");
        const dot = one<HTMLElement>(".vs-cap-dot");
        const labels = q(".vs-cap-labels b");
        const keys = q(".vs-key");
        const keysEl = one<HTMLElement>(".vs-keys");
        const tcard = one<HTMLElement>(".vs-tcard");
        const hist = one<HTMLElement>(".vs-hist");
        const toks = q(".vs-tok");
        const fillers = q(".vs-tok[data-f]");
        const strikes = q(".vs-strike");
        const raws = q(".vs-tok[data-c] .vs-raw");
        const cleans = q(".vs-tok[data-c] .vs-clean");
        const endDot = one<HTMLElement>(".vs-end");
        const chips = one<HTMLElement>(".vs-chips");
        const pill = one<HTMLElement>(".vs-chip-pill");
        const hint = one<HTMLElement>(".vs-hint");
        const tl1 = q(".vs-tlabel b");
        const landed = q(".vs-land span");
        const histBits = q(".vs-hist-in > *");
        const ring = one<SVGElement>(".vs-ring");
        const items = q(".vs-rail li");
        const capts = q(".vs-capt > div");
        const prog = one<HTMLElement>(".vs-prog i");
        const tilt = one<HTMLElement>(".vs-tilt");

        // Fit the 680 x 500 stage into the column and into the screen height.
        const fit = () => {
          const s = Math.min(
            1,
            box.clientWidth / 680,
            (pin.clientHeight - 24) / 500,
          );
          box.style.setProperty("--s", String(Math.max(0.5, s)));
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(box);
        ro.observe(pin);

        // The live waveform is drawn here, at the display's frame rate, only while it matters.
        const live = { listen: 0, on: false };
        const ctx = canvas.getContext("2d");
        const BARS = 17;
        const W = 96;
        const H = 28;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        let clear = true;
        const draw = (time: number) => {
          if (!ctx || !live.on) return;
          if (live.listen < 0.01) {
            if (!clear) ctx.clearRect(0, 0, canvas.width, canvas.height);
            clear = true;
            return;
          }
          clear = false;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, W, H);
          ctx.fillStyle = EMBER;
          const speech =
            0.55 + 0.45 * Math.sin(time * 2.3) * Math.sin(time * 0.9 + 1.2);
          for (let i = 0; i < BARS; i++) {
            const x = 3 + i * ((W - 6) / (BARS - 1));
            const env = Math.pow(Math.sin((Math.PI * (i + 0.5)) / BARS), 1.2);
            const wob =
              0.5 +
              0.5 *
                Math.sin(time * 6.1 + i * 0.83) *
                Math.cos(time * 3.7 + i * 1.7);
            const h = Math.max(
              3,
              H * live.listen * (0.18 + 0.82 * env * wob * speech),
            );
            ctx.beginPath();
            ctx.roundRect(x - 1.5, (H - h) / 2, 3, h, 1.5);
            ctx.fill();
          }
        };
        gsap.ticker.add(draw);

        gsap.set([cap], { xPercent: -50 });
        gsap.set([cap, tcard, hist, keysEl], { z: 36 });
        gsap.set(cap, { opacity: 0, y: 14, scale: 0.9, width: 56 });
        gsap.set(waveWrap, { width: 0 });
        gsap.set(glyph, { opacity: 0, transformOrigin: "50% 50%" });
        gsap.set(labels, { opacity: 0 });
        gsap.set(tcard, { opacity: 0, y: 18 });
        gsap.set(toks, { opacity: 0, y: 8 });
        gsap.set(strikes, { scaleX: 0, transformOrigin: "0 50%" });
        gsap.set(cleans, { opacity: 0 });
        gsap.set(endDot, { opacity: 0 });
        gsap.set(chips, { opacity: 0, y: 8 });
        gsap.set(landed, { opacity: 0, y: 6 });
        gsap.set(hist, { opacity: 0, x: 44 });
        gsap.set(histBits, { opacity: 0, y: 6 });
        gsap.set(tl1[1], { opacity: 0 });
        gsap.set(hint, { opacity: 0 });
        gsap.set(capts.slice(1), { opacity: 0, y: 10 });
        gsap.set(prog, { scaleY: 0, transformOrigin: "50% 0" });
        gsap.set(glyphPath, { attr: { d: WAVE } });
        gsap.set(tilt, {
          rotationX: 7,
          rotationY: -9,
          transformPerspective: 1400,
        });
        gsap.set(ring, { drawSVG: "0%" });
        gsap.set(keys, { "--p": 0, y: 0 });
        gsap.set(items[0], { "--on": 1 });

        const STEP = 2;
        const tl = gsap.timeline({
          defaults: { ease: "power2.out" },
          scrollTrigger: {
            trigger: pin,
            start: "top top+=64",
            end: () => "+=" + Math.round(window.innerHeight * 5.4),
            pin: true,
            scrub: 0.7,
            anticipatePin: 1,
            invalidateOnRefresh: true,
            onToggle: (self) => {
              live.on = self.isActive;
            },
            onUpdate: (self) => {
              const step = Math.min(5, Math.floor(self.progress * 6));
              items.forEach((li, i) =>
                i === step
                  ? li.setAttribute("aria-current", "step")
                  : li.removeAttribute("aria-current"),
              );
            },
          },
        });

        // Rail, captions and the progress line follow the same clock.
        tl.to(prog, { scaleY: 1, duration: 12, ease: "none" }, 0);
        for (let i = 1; i < 6; i++) {
          tl.to(
            capts[i - 1],
            { opacity: 0, y: -10, duration: 0.35 },
            i * STEP - 0.2,
          );
          tl.fromTo(
            capts[i],
            { opacity: 0, y: 10 },
            { opacity: 1, y: 0, duration: 0.45 },
            i * STEP + 0.05,
          );
          tl.to(items[i - 1], { "--on": 0, duration: 0.3 }, i * STEP - 0.1);
          tl.to(items[i], { "--on": 1, duration: 0.3 }, i * STEP);
        }
        tl.to(
          tilt,
          { rotationX: 0, rotationY: 0, duration: 7, ease: "power1.inOut" },
          0,
        );

        // 1. Hold: the keys go down and the bar appears.
        tl.to(keys, { y: 2, "--p": 1, duration: 0.4, stagger: 0.14 }, 0.3);
        tl.to(
          cap,
          { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: "back.out(1.7)" },
          1.0,
        );

        // 2. Speak: the bar opens up and shows the live level; the words arrive.
        tl.to(cap, { width: 256, duration: 0.7, ease: "power3.inOut" }, 2.0);
        tl.to(
          waveWrap,
          { width: 96, duration: 0.7, ease: "power3.inOut" },
          2.0,
        );
        tl.to(labels[0], { opacity: 1, duration: 0.3 }, 2.5);
        tl.to(live, { listen: 1, duration: 0.7, ease: "none" }, 2.2);
        tl.to(tcard, { opacity: 1, y: 0, duration: 0.6 }, 2.5);
        tl.to(toks, { opacity: 1, y: 0, duration: 0.35, stagger: 0.12 }, 2.8);

        // 3. Clean up: the bar thinks, fillers are struck, capitals and the full stop arrive.
        tl.to(live, { listen: 0, duration: 0.4, ease: "none" }, 4.0);
        tl.to(waveWrap, { width: 0, duration: 0.5, ease: "power3.inOut" }, 4.0);
        tl.to(cap, { width: 150, duration: 0.6, ease: "power3.inOut" }, 4.0);
        tl.to(dot, { opacity: 0, scale: 0.3, duration: 0.3 }, 4.0);
        tl.to(glyph, { opacity: 1, duration: 0.3 }, 4.2);
        tl.to(labels[0], { opacity: 0, duration: 0.2 }, 4.0);
        tl.to(labels[1], { opacity: 1, duration: 0.3 }, 4.3);
        tl.to(
          glyphPath,
          { morphSVG: SPIN, duration: 0.7, ease: "power2.inOut" },
          4.3,
        );
        tl.to(glyph, { rotation: 720, duration: 1.3, ease: "none" }, 4.3);
        tl.to(tl1[0], { opacity: 0, duration: 0.3 }, 5.0);
        tl.to(tl1[1], { opacity: 1, duration: 0.3 }, 5.1);
        tl.to(strikes, { scaleX: 1, duration: 0.35, stagger: 0.25 }, 4.5);
        tl.to(fillers, { opacity: 0, duration: 0.25 }, 5.1);
        tl.to(
          fillers,
          { width: 0, marginRight: 0, duration: 0.4, ease: "power3.inOut" },
          5.15,
        );
        tl.to(raws, { opacity: 0, duration: 0.3 }, 5.35);
        tl.to(cleans, { opacity: 1, duration: 0.3 }, 5.35);
        tl.to(endDot, { opacity: 1, duration: 0.3 }, 5.5);
        tl.to(
          glyphPath,
          {
            morphSVG: CHECK,
            stroke: GREEN,
            duration: 0.5,
            ease: "power2.inOut",
          },
          5.6,
        );
        tl.to(labels[1], { opacity: 0, duration: 0.2 }, 5.6);
        tl.to(labels[2], { opacity: 1, duration: 0.3 }, 5.8);
        tl.to(cap, { width: 124, duration: 0.5, ease: "power3.inOut" }, 5.6);

        // 4. Style: the same sentence, in the tone of the app.
        tl.to(tcard, { height: 176, duration: 0.5, ease: "power3.inOut" }, 6.0);
        tl.to(chips, { opacity: 1, y: 0, duration: 0.5 }, 6.3);
        tl.to(hint, { opacity: 1, duration: 0.4 }, 6.5);
        tl.to(pill, { x: 108, duration: 0.6, ease: "power3.inOut" }, 7.0);
        tl.to(endDot, { opacity: 0, duration: 0.3 }, 7.3);

        // 5. Lands: the text moves to the cursor in the app.
        tl.to(
          tcard,
          { opacity: 0, y: 40, scale: 0.97, duration: 0.7, ease: "power2.in" },
          8.0,
        );
        tl.to(landed, { opacity: 1, y: 0, duration: 0.3, stagger: 0.12 }, 8.5);
        tl.to(cap, { opacity: 0, y: 12, duration: 0.5 }, 9.4);
        tl.to(keys, { y: 0, "--p": 0, duration: 0.4, stagger: 0.08 }, 9.4);

        // 6. Saved: a History entry slides in.
        tl.to(
          hist,
          { opacity: 1, x: 0, duration: 0.7, ease: "power3.out" },
          10.1,
        );
        tl.to(
          histBits,
          { opacity: 1, y: 0, duration: 0.4, stagger: 0.1 },
          10.4,
        );
        tl.to(ring, { drawSVG: "100%", duration: 0.9, ease: "none" }, 10.9);
        tl.set({}, {}, 12);

        return () => {
          ro.disconnect();
          gsap.ticker.remove(draw);
        };
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section id="how" ref={root} className="vs" aria-labelledby="how-title">
      <div className="container-m vs-head">
        <Heading
          id="how-title"
          eyebrow="How it works"
          sub="Scroll to follow one sentence from your voice to your cursor. The scene is an illustration."
        >
          From <em>voice</em> to text
        </Heading>
      </div>

      <div className="vs-pin">
        <div className="container-m vs-grid">
          <div className="vs-left">
            <div className="vs-prog" aria-hidden="true">
              <i />
            </div>
            <ol className="vs-rail">
              {STEPS.map((s) => (
                <li key={s.n}>
                  <span className="vs-rail-n">
                    <span>{s.n}</span>
                  </span>
                  <span className="vs-rail-l">{s.label}</span>
                </li>
              ))}
            </ol>
            <div className="vs-capt">
              {STEPS.map((s) => (
                <div key={s.n}>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="vs-stagebox">
            <div className="vs-stage" aria-hidden="true">
              <div className="vs-tilt">
                <div className="vs-keys">
                  {KEYS.map((k) => (
                    <span key={k.cap} className="keycap vs-key">
                      <b>{k.cap}</b>
                      {k.name && <small>{k.name}</small>}
                    </span>
                  ))}
                </div>

                <div className="vs-win">
                  <div className="vs-bar">
                    <i />
                    <i />
                    <i />
                    <span>Messages</span>
                  </div>
                  <div className="vs-chat">
                    <p className="vs-bubble">
                      Is the review still on Thursday?
                    </p>
                    <div className="vs-input">
                      <p className="vs-land">
                        {LANDED.map((w, i) => (
                          <span key={i}>{w}</span>
                        ))}
                      </p>
                      <em className="vs-caretline" />
                    </div>
                  </div>
                </div>

                <div className="vs-tcard">
                  <p className="vs-tlabel">
                    <span className="vs-live" />
                    <b>What you said</b>
                    <b>Cleaned up</b>
                  </p>
                  <p className="vs-line">
                    {TOKENS.map((k, i) => {
                      const filler = "filler" in k;
                      const clean = "clean" in k ? k.clean : undefined;
                      return (
                        <span key={i}>
                          <span
                            className="vs-tok"
                            data-f={filler ? "" : undefined}
                            data-c={clean ? "" : undefined}
                          >
                            <span className="vs-raw">{k.t}</span>
                            {clean && <span className="vs-clean">{clean}</span>}
                            {filler && <i className="vs-strike" />}
                          </span>
                          {"end" in k && <span className="vs-end">.</span>}
                        </span>
                      );
                    })}
                  </p>
                  <div className="vs-chips">
                    <span className="vs-chip-pill" />
                    {STYLES.map((s) => (
                      <span key={s}>{s}</span>
                    ))}
                  </div>
                  <p className="vs-hint">Personal messages: Casual</p>
                </div>

                <div className="vs-cap">
                  <span className="vs-cap-ico">
                    <i className="vs-cap-dot" />
                    <svg viewBox="0 0 32 32" className="vs-glyph">
                      <path d={WAVE} />
                    </svg>
                  </span>
                  <span className="vs-cap-wave">
                    <canvas className="vs-canvas" />
                  </span>
                  <span className="vs-cap-labels">
                    <b>Listening</b>
                    <b>Tidying up</b>
                    <b>Done</b>
                  </span>
                </div>

                <div className="vs-hist">
                  <div className="vs-hist-in">
                    <p className="vs-hist-h">
                      <Icon name="history" size={14} />
                      History
                    </p>
                    <p className="vs-hist-t">So the review moved to Friday</p>
                    <p className="vs-hist-m">Messages · just now · 6 words</p>
                    <span className="vs-play">
                      <svg viewBox="0 0 28 28" width="28" height="28">
                        <circle cx="14" cy="14" r="12" className="vs-ring-bg" />
                        <circle
                          cx="14"
                          cy="14"
                          r="12"
                          className="vs-ring"
                          transform="rotate(-90 14 14)"
                        />
                        <path d="M11.5 9.5v9l7-4.5z" />
                      </svg>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <ol className="container-m vs-cards">
        {STEPS.map((s, i) => (
          <li key={s.n} className="card vs-card" data-rv>
            <div className="vs-card-vis" aria-hidden="true">
              <StepVisual index={i} />
            </div>
            <p className="vs-card-n">Step {s.n}</p>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Still pictures of each step, for small screens and for people who prefer less motion. */
function StepVisual({ index }: { index: number }) {
  switch (index) {
    case 0:
      return (
        <div className="vs-mini-keys">
          {KEYS.map((k) => (
            <span key={k.cap} className="keycap" data-down="true">
              {k.cap}
            </span>
          ))}
        </div>
      );
    case 1:
      return (
        <div className="vs-mini-cap">
          <i />
          <span>
            {[5, 11, 8, 15, 10, 16, 7, 12, 6].map((h, n) => (
              <b
                key={n}
                className="wave-bar"
                style={{ height: h, ["--d" as string]: `${n * 90}ms` }}
              />
            ))}
          </span>
          <em>Listening</em>
        </div>
      );
    case 2:
      return (
        <p className="vs-mini-text">
          <s>um</s> so the <s>uh</s> review moved to friday
          <span className="vs-mini-arrow">
            <Icon name="chevron" size={18} />
          </span>
          <strong>So the review moved to Friday.</strong>
        </p>
      );
    case 3:
      return (
        <div className="vs-mini-style">
          <div className="vs-mini-chips">
            {STYLES.map((s) => (
              <span key={s} data-on={s === "Casual" ? "" : undefined}>
                {s}
              </span>
            ))}
          </div>
          <p>So the review moved to Friday</p>
        </div>
      );
    case 4:
      return (
        <div className="vs-mini-input">
          So the review moved to Friday
          <i />
        </div>
      );
    default:
      return (
        <div className="vs-mini-hist">
          <div>
            <b>So the review moved to Friday</b>
            <small>Messages · just now · 6 words</small>
          </div>
          <Icon name="play" size={18} />
        </div>
      );
  }
}
