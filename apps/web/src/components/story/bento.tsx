"use client";

import type { IconName } from "../../content/features.ts";
import { FEATURES } from "../../content/features.ts";
import { Icon } from "../icons.tsx";
import { AnimIcon } from "./anim-icon.tsx";
import { GlowCard } from "./glow-card.tsx";
import { gsap, useLoop } from "./motion.ts";
import "./bento.css";

type Q = ReturnType<typeof gsap.utils.selector>;
const sel = (root: HTMLElement): Q => gsap.utils.selector(root);

function Words({
  text,
  className = "bt-w",
}: {
  text: string;
  className?: string;
}) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <span key={i} className={className}>
          {w}{" "}
        </span>
      ))}
    </>
  );
}

/* ---------- Dictation anywhere ---------- */
const APPS: { icon: IconName; label: string }[] = [
  { icon: "mail", label: "Mail" },
  { icon: "chat", label: "Chat" },
  { icon: "doc", label: "Documents" },
  { icon: "terminal", label: "Terminal" },
];
function DictationLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const pill = q(".bt-tabpill")[0];
    const words = q(".bt-w");
    APPS.forEach((_, i) => {
      const t = i * 3.2;
      tl.to(pill, { x: i * 52, duration: 0.55, ease: "power3.inOut" }, t);
      tl.fromTo(
        words,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, stagger: 0.09, duration: 0.3 },
        t + 0.5,
      );
      tl.to(words, { opacity: 0, duration: 0.25 }, t + 2.9);
    });
  });
  return (
    <div ref={ref} className="bt-vis">
      <div className="bt-tabs">
        <span className="bt-tabpill" />
        {APPS.map((a) => (
          <span key={a.label} className="bt-tab" title={a.label}>
            <Icon name={a.icon} size={18} />
          </span>
        ))}
      </div>
      <p className="bt-serif">
        <Words text="Thanks for the update, I will review it tonight." />
        <i className="bt-cursor caret" />
      </p>
    </div>
  );
}

/* ---------- Cleanup ---------- */
function CleanupLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const raw = q(".bt-raw")[0];
    const fin = q(".bt-fin")[0];
    const strikes = q(".bt-strike");
    const fillers = q(".bt-filler");
    tl.set(raw, { opacity: 1 }, 0);
    tl.set(fin, { opacity: 0 }, 0);
    tl.set(strikes, { scaleX: 0 }, 0);
    tl.to(
      strikes,
      { scaleX: 1, duration: 0.4, stagger: 0.3, ease: "power2.out" },
      0.8,
    );
    tl.to(fillers, { opacity: 0.25, duration: 0.3 }, 1.7);
    tl.to(raw, { opacity: 0, y: -6, duration: 0.4 }, 2.3);
    tl.fromTo(
      fin,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.5 },
      2.4,
    );
    tl.to({}, { duration: 2 }, 3);
  });
  return (
    <div ref={ref} className="bt-vis">
      <div className="bt-stack bt-serif">
        <p className="bt-raw">
          <span className="bt-filler">
            um
            <i className="bt-strike" />
          </span>{" "}
          so the{" "}
          <span className="bt-filler">
            uh
            <i className="bt-strike" />
          </span>{" "}
          review moved to friday
        </p>
        <p className="bt-fin">So the review moved to Friday.</p>
      </div>
    </div>
  );
}

/* ---------- Styles ---------- */
const TONES = [
  {
    app: "Email",
    style: "Formal",
    text: "Thanks for the update. The review moved to Friday.",
  },
  {
    app: "Work chat",
    style: "Casual",
    text: "Thanks for the update. The review moved to Friday",
  },
  {
    app: "Personal",
    style: "Very casual",
    text: "thanks for the update. the review moved to Friday",
  },
];
function StylesLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const pill = q(".bt-seg-pill")[0];
    const sentences = q(".bt-tone");
    const tags = q(".bt-tag");
    TONES.forEach((_, i) => {
      const t = i * 2.6;
      if (i > 0) {
        tl.to(pill, { x: i * 68, duration: 0.5, ease: "power3.inOut" }, t);
        tl.to(
          [sentences[i - 1], tags[i - 1]],
          { opacity: 0, y: -6, duration: 0.3 },
          t,
        );
        tl.fromTo(
          [sentences[i], tags[i]],
          { opacity: 0, y: 8 },
          { opacity: 1, y: 0, duration: 0.4 },
          t + 0.25,
        );
      }
    });
    tl.set(sentences.slice(1), { opacity: 0 }, 0);
    tl.set(tags.slice(1), { opacity: 0 }, 0);
    tl.to({}, { duration: 1.2 }, 7.2);
    tl.to([sentences[2], tags[2]], { opacity: 0, duration: 0.3 }, 7.6);
    tl.to(pill, { x: 0, duration: 0.5, ease: "power3.inOut" }, 7.6);
    tl.to([sentences[0], tags[0]], { opacity: 1, y: 0, duration: 0.4 }, 7.9);
  }, 0.6);
  return (
    <div ref={ref} className="bt-vis">
      <div className="bt-seg">
        <span className="bt-seg-pill" />
        {TONES.map((t) => (
          <span key={t.app}>{t.app}</span>
        ))}
      </div>
      <div className="bt-tones">
        {TONES.map((t, i) => (
          <p
            key={t.app}
            className="bt-tone bt-serif"
            style={i ? { opacity: 0 } : undefined}
          >
            {t.text}
          </p>
        ))}
      </div>
      <div className="bt-tags">
        {TONES.map((t, i) => (
          <span
            key={t.app}
            className="bt-tag"
            style={i ? { opacity: 0 } : undefined}
          >
            {t.style}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------- Dictionary ---------- */
function DictionaryLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const wrong = q(".bt-wrong")[0];
    const right = q(".bt-right")[0];
    const squig = q(".bt-squig")[0];
    const entry = q(".bt-entry")[0];
    const check = q(".bt-check path")[0];
    tl.set(wrong, { opacity: 1 }, 0);
    tl.set(right, { opacity: 0 }, 0);
    tl.set(entry, { opacity: 0, y: 8 }, 0);
    tl.set(squig, { scaleX: 0 }, 0);
    tl.set(check, { drawSVG: "0%" }, 0);
    tl.to(squig, { scaleX: 1, duration: 0.6, ease: "power2.out" }, 0.7);
    tl.to(entry, { opacity: 1, y: 0, duration: 0.45 }, 1.5);
    tl.to(wrong, { opacity: 0, y: -8, duration: 0.3 }, 2.4);
    tl.to(squig, { opacity: 0, duration: 0.2 }, 2.4);
    tl.fromTo(
      right,
      { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.45 },
      2.5,
    );
    tl.to(check, { drawSVG: "100%", duration: 0.4 }, 2.9);
    tl.to({}, { duration: 2.2 }, 3.3);
  });
  return (
    <div ref={ref} className="bt-vis">
      <p className="bt-serif bt-center">
        Deploy it to{" "}
        <span className="bt-swap">
          <span className="bt-wrong">
            kuber netties
            <svg
              className="bt-squig"
              viewBox="0 0 100 6"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d="M0 3 Q6 0 12 3 T25 3 T37 3 T50 3 T62 3 T75 3 T87 3 T100 3" />
            </svg>
          </span>
          <span className="bt-right">
            Kubernetes
            <svg className="bt-check" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          </span>
        </span>
      </p>
      <p className="bt-entry bt-chip">
        <span>kuber netties</span>
        <Icon name="chevron" size={14} className="bt-arrow" />
        <b>Kubernetes</b>
      </p>
    </div>
  );
}

/* ---------- Snippets ---------- */
function SnippetsLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const phrase = q(".bt-phrase")[0];
    const body = q(".bt-expand")[0];
    const arrow = q(".bt-snarrow path")[0];
    tl.set(phrase, { opacity: 0, y: 8 }, 0);
    tl.set(body, { clipPath: "inset(0 100% 0 0)" }, 0);
    tl.set(arrow, { drawSVG: "0%" }, 0);
    tl.to(phrase, { opacity: 1, y: 0, duration: 0.45 }, 0.3);
    tl.to(arrow, { drawSVG: "100%", duration: 0.5 }, 1.2);
    tl.to(
      body,
      { clipPath: "inset(0 0% 0 0)", duration: 0.8, ease: "power2.inOut" },
      1.6,
    );
    tl.to({}, { duration: 2.6 }, 2.4);
    tl.to([phrase, body], { opacity: 0, duration: 0.4 }, 4.6);
  }, 0.5);
  return (
    <div ref={ref} className="bt-vis bt-col">
      <p className="bt-phrase bt-chip">
        <Icon name="mic" size={14} />
        <span>my booking link</span>
      </p>
      <svg className="bt-snarrow" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v15m-5-5 5 5 5-5" />
      </svg>
      <p className="bt-expand bt-mono">https://example.com/book</p>
    </div>
  );
}

/* ---------- Transforms ---------- */
function TransformsLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const sel1 = q(".bt-selbar")[0];
    const chip = q(".bt-polish")[0];
    const panel = q(".bt-panel")[0];
    const words = q(".bt-rw");
    const btn = q(".bt-replace")[0];
    tl.set(sel1, { scaleX: 0 }, 0);
    tl.set(chip, { opacity: 0, scale: 0.85 }, 0);
    tl.set(panel, { opacity: 0, y: 14 }, 0);
    tl.set(words, { opacity: 0 }, 0);
    tl.to(sel1, { scaleX: 1, duration: 0.7, ease: "power2.inOut" }, 0.5);
    tl.to(
      chip,
      { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(2)" },
      1.4,
    );
    tl.to(panel, { opacity: 1, y: 0, duration: 0.5 }, 1.9);
    tl.to(words, { opacity: 1, duration: 0.2, stagger: 0.1 }, 2.2);
    tl.to(btn, { scale: 0.94, duration: 0.15, yoyo: true, repeat: 1 }, 4.1);
    tl.to({}, { duration: 1.6 }, 4.4);
  }, 0.4);
  return (
    <div ref={ref} className="bt-vis">
      <div className="bt-row">
        <p className="bt-orig">
          <span className="bt-selbar" />
          <span className="bt-origtext">hey can u send me teh file asap</span>
        </p>
        <span className="bt-polish bt-chip">
          <Icon name="wand" size={14} />
          Polish
        </span>
      </div>
      <div className="bt-panel">
        <p className="bt-serif">
          <Words
            text="Could you send me the file when you can?"
            className="bt-rw"
          />
        </p>
        <span className="bt-replace">Replace</span>
      </div>
    </div>
  );
}

/* ---------- Scratchpad ---------- */
const NOTE = [
  "Call back about the invoice",
  "Draft the update for Friday",
  "Ask design for the final icons",
];
function ScratchpadLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const lines = NOTE.map((_, i) => q(`.bt-nl-${i} .bt-nw`));
    const saved = q(".bt-saved")[0];
    const tick = q(".bt-saved path")[0];
    lines.forEach((ws, i) =>
      tl.fromTo(
        ws,
        { opacity: 0, y: 5 },
        { opacity: 1, y: 0, stagger: 0.1, duration: 0.25 },
        0.4 + i * 1.3,
      ),
    );
    tl.set(saved, { opacity: 0 }, 0);
    tl.set(tick, { drawSVG: "0%" }, 0);
    tl.to(saved, { opacity: 1, duration: 0.3 }, 4.3);
    tl.to(tick, { drawSVG: "100%", duration: 0.4 }, 4.4);
    tl.to({}, { duration: 2.4 }, 4.8);
  });
  return (
    <div ref={ref} className="bt-vis">
      <div className="bt-note">
        <p className="bt-note-h">
          <b>Launch week</b>
          <span className="bt-saved">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
            Saved
          </span>
        </p>
        {NOTE.map((l, i) => (
          <p key={l} className={`bt-nl-${i}`}>
            <Words text={l} className="bt-nw" />
          </p>
        ))}
      </div>
    </div>
  );
}

/* ---------- Command Mode ---------- */
function CommandLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const before = q(".bt-before")[0];
    const after = q(".bt-after")[0];
    const say = q(".bt-say")[0];
    const sel1 = q(".bt-selbar")[0];
    const dot = q(".bt-say i")[0];
    tl.set(before, { opacity: 1 }, 0);
    tl.set(after, { opacity: 0 }, 0);
    tl.set(say, { opacity: 0, y: 10 }, 0);
    tl.set(sel1, { scaleX: 0 }, 0);
    tl.to(sel1, { scaleX: 1, duration: 0.5 }, 0.4);
    tl.to(say, { opacity: 1, y: 0, duration: 0.45 }, 1.1);
    tl.to(
      dot,
      { scale: 1.5, opacity: 0.4, duration: 0.35, yoyo: true, repeat: 3 },
      1.3,
    );
    tl.to(before, { opacity: 0, y: -6, duration: 0.35 }, 2.8);
    tl.fromTo(
      after,
      { opacity: 0, y: 6 },
      { opacity: 1, y: 0, duration: 0.5 },
      2.9,
    );
    tl.to(sel1, { opacity: 0, duration: 0.3 }, 2.9);
    tl.to({}, { duration: 2.4 }, 3.4);
  }, 0.4);
  return (
    <div ref={ref} className="bt-vis">
      <p className="bt-say bt-chip">
        <i />
        “make it friendlier”
      </p>
      <div className="bt-stack bt-serif">
        <p className="bt-before">
          <span className="bt-selbar" />
          <span className="bt-origtext">Send me the report.</span>
        </p>
        <p className="bt-after">
          Could you send me the report when you get a moment?
        </p>
      </div>
    </div>
  );
}

/* ---------- Vibe coding ---------- */
function VibeLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const spoken = q(".bt-sp");
    const pre = q(".bt-pre")[0];
    const tag = q(".bt-filetag")[0];
    const post = q(".bt-post")[0];
    tl.set(spoken, { opacity: 0 }, 0);
    tl.set([pre, post], { opacity: 0 }, 0);
    tl.set(tag, { opacity: 0, scale: 0.6 }, 0);
    tl.to(spoken, { opacity: 1, stagger: 0.12, duration: 0.25 }, 0.4);
    tl.to(pre, { opacity: 1, duration: 0.3 }, 2.2);
    tl.to(
      tag,
      { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2.4)" },
      2.5,
    );
    tl.to(post, { opacity: 1, duration: 0.35 }, 3);
    tl.to({}, { duration: 2.4 }, 3.4);
  }, 0.4);
  return (
    <div ref={ref} className="bt-vis bt-code">
      <p className="bt-said">
        <Icon name="mic" size={14} />
        <Words
          text="update at auth dot ts to check the session token"
          className="bt-sp"
        />
      </p>
      <p className="bt-mono bt-prompt">
        <span className="bt-pre">Update </span>
        <span className="bt-filetag">@auth.ts</span>
        <span className="bt-post"> to check the session token</span>
      </p>
    </div>
  );
}

/* ---------- Languages ---------- */
const HELLOS = [
  { w: "Hello", l: "English" },
  { w: "Salom", l: "Uzbek" },
  { w: "Hola", l: "Spanish" },
  { w: "Bonjour", l: "French" },
  { w: "Hallo", l: "German" },
  { w: "Merhaba", l: "Turkish" },
];
function LanguagesLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const groups = HELLOS.map((_, i) => q(`.bt-hello-${i} .bt-ch`));
    const labels = q(".bt-lang");
    tl.set(q(".bt-hello, .bt-lang"), { visibility: "visible" }, 0);
    tl.set(groups.slice(1).flat(), { yPercent: 115 }, 0);
    tl.set(labels.slice(1), { opacity: 0 }, 0);
    HELLOS.forEach((_, i) => {
      const next = (i + 1) % HELLOS.length;
      const t = 1.5 + i * 1.7;
      tl.to(
        groups[i],
        { yPercent: -115, duration: 0.55, stagger: 0.04, ease: "power3.in" },
        t,
      );
      tl.to(labels[i], { opacity: 0, duration: 0.25 }, t);
      tl.fromTo(
        groups[next],
        { yPercent: 115 },
        { yPercent: 0, duration: 0.7, stagger: 0.05, ease: "power3.out" },
        t + 0.45,
      );
      tl.to(labels[next], { opacity: 1, duration: 0.35 }, t + 0.7);
    });
  }, 0.2);
  return (
    <div ref={ref} className="bt-vis bt-center">
      <div className="bt-hellos bt-serif" aria-hidden="true">
        {HELLOS.map((h, i) => (
          <span key={h.w} className={`bt-hello bt-hello-${i}`}>
            {h.w.split("").map((c, n) => (
              <span key={n} className="bt-ch">
                {c}
              </span>
            ))}
          </span>
        ))}
      </div>
      <div className="bt-langs" aria-hidden="true">
        {HELLOS.map((h) => (
          <span key={h.l} className="bt-lang bt-chip">
            {h.l}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------- History ---------- */
const HIST = [
  { t: "So the review moved to Friday", m: "Messages · just now" },
  { t: "Draft the update for Friday", m: "Notes · 12 min ago" },
  { t: "Call back about the invoice", m: "Mail · yesterday" },
];
function HistoryLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const rows = q(".bt-hrow");
    const ring = q(".bt-hring")[0];
    tl.set(ring, { drawSVG: "0%" }, 0);
    tl.fromTo(
      rows,
      { opacity: 0, x: 24 },
      { opacity: 1, x: 0, stagger: 0.18, duration: 0.5 },
      0.3,
    );
    tl.to(ring, { drawSVG: "100%", duration: 1.6, ease: "none" }, 1.6);
    tl.to({}, { duration: 1.6 }, 3.2);
    tl.to(rows, { opacity: 0, duration: 0.4 }, 4.6);
  }, 0.3);
  return (
    <div ref={ref} className="bt-vis bt-hist">
      {HIST.map((h, i) => (
        <div key={h.t} className="bt-hrow">
          <div>
            <b>{h.t}</b>
            <small>{h.m}</small>
          </div>
          {i === 0 && (
            <svg viewBox="0 0 28 28" width="26" height="26" aria-hidden="true">
              <circle cx="14" cy="14" r="12" className="bt-hbg" />
              <circle
                cx="14"
                cy="14"
                r="12"
                className="bt-hring"
                transform="rotate(-90 14 14)"
              />
              <path d="M11.5 9.5v9l7-4.5z" />
            </svg>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- MCP ---------- */
function McpLive() {
  const ref = useLoop((tl, root) => {
    const q = sel(root);
    const knob = q(".bt-knob")[0];
    const sw = q(".bt-switch")[0];
    const line = q(".bt-mline")[0];
    const dot = q(".bt-mdot")[0];
    const app = q(".bt-mapp")[0];
    const lbl = q(".bt-mstate");
    tl.set(lbl, { visibility: "visible" }, 0);
    tl.set(sw, { "--on": 0 }, 0);
    tl.set(knob, { x: 0 }, 0);
    tl.set(line, { drawSVG: "0%" }, 0);
    tl.set(dot, { opacity: 0 }, 0);
    tl.set(app, { "--on": 0 }, 0);
    tl.set(lbl[1], { opacity: 0 }, 0);
    tl.to(knob, { x: 16, duration: 0.35, ease: "power2.inOut" }, 0.8);
    tl.to(sw, { "--on": 1, duration: 0.35 }, 0.8);
    tl.to(lbl[0], { opacity: 0, duration: 0.2 }, 0.8);
    tl.to(lbl[1], { opacity: 1, duration: 0.3 }, 1);
    tl.to(line, { drawSVG: "100%", duration: 0.8, ease: "power2.inOut" }, 1.3);
    tl.to(app, { "--on": 1, duration: 0.4 }, 2);
    tl.set(dot, { opacity: 1, x: 0 }, 2.2);
    tl.to(dot, { x: 120, duration: 1.1, ease: "power1.inOut", repeat: 1 }, 2.2);
    tl.to({}, { duration: 1.4 }, 4.4);
  }, 0.4);
  return (
    <div ref={ref} className="bt-vis bt-mcp">
      <div className="bt-mbox">
        <Icon name="notes" size={18} />
        <span>Meeting notes</span>
      </div>
      <div className="bt-mwire">
        <span className="bt-mtop">
          <span className="bt-switch">
            <i className="bt-knob" />
          </span>
          <span className="bt-mstates">
            <b className="bt-mstate">Off</b>
            <b className="bt-mstate">On</b>
          </span>
        </span>
        <svg viewBox="0 0 140 12" preserveAspectRatio="none" aria-hidden="true">
          <path className="bt-mline" d="M2 6H138" />
          <circle className="bt-mdot" cx="6" cy="6" r="3" />
        </svg>
      </div>
      <div className="bt-mbox bt-mapp">
        <Icon name="plug" size={18} />
        <span>AI app</span>
      </div>
    </div>
  );
}

const LIVE: Record<string, () => React.ReactNode> = {
  dictation: () => <DictationLive />,
  cleanup: () => <CleanupLive />,
  styles: () => <StylesLive />,
  dictionary: () => <DictionaryLive />,
  snippets: () => <SnippetsLive />,
  transforms: () => <TransformsLive />,
  scratchpad: () => <ScratchpadLive />,
  command: () => <CommandLive />,
  vibe: () => <VibeLive />,
  languages: () => <LanguagesLive />,
  history: () => <HistoryLive />,
  mcp: () => <McpLive />,
};

/** The bento order: what sits next to what. Notetaker has its own section below. */
const ORDER = [
  "dictation",
  "cleanup",
  "styles",
  "dictionary",
  "snippets",
  "transforms",
  "scratchpad",
  "command",
  "vibe",
  "languages",
  "history",
  "mcp",
];

export function FeatureBento() {
  const byId = new Map(FEATURES.map((f) => [f.id, f]));
  return (
    <ul className="bento">
      {ORDER.map((id) => {
        const f = byId.get(id);
        if (!f) return null;
        const wide =
          id === "dictation" ||
          id === "transforms" ||
          id === "vibe" ||
          id === "languages";
        return (
          <li key={id} className={`bt ${wide ? "bt-wide" : ""}`} data-rv>
            <GlowCard className="bt-card">
              <div className="bt-live" aria-hidden="true">
                {LIVE[id]()}
              </div>
              <div className="bt-text">
                <AnimIcon name={f.icon} className="bt-icon" />
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            </GlowCard>
          </li>
        );
      })}
    </ul>
  );
}
