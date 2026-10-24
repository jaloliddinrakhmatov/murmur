"use client";

import { useRef } from "react";
import { FAQ } from "../../content/sections.ts";
import { Heading } from "./heading.tsx";
import { NO_PREF, gsap } from "./motion.ts";
import "./faq.css";

/**
 * Native <details>, so search, keyboard and assistive technology behave as usual. The height
 * and the plus-to-minus icon animate on top; with reduced motion the browser's own toggle runs.
 */
function Item({ q, a }: { q: string; a: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);

  const toggle = (e: React.MouseEvent) => {
    const d = ref.current;
    const b = body.current;
    if (!d || !b || !window.matchMedia(NO_PREF).matches) return;
    e.preventDefault();
    gsap.killTweensOf(b);
    if (!d.open) {
      d.open = true;
      d.dataset.state = "open";
      gsap.fromTo(
        b,
        { height: 0, opacity: 0 },
        {
          height: "auto",
          opacity: 1,
          duration: 0.5,
          ease: "power3.out",
          onComplete: () => {
            gsap.set(b, { clearProps: "height,opacity" });
          },
        },
      );
    } else {
      d.dataset.state = "closed";
      gsap.to(b, {
        height: 0,
        opacity: 0,
        duration: 0.35,
        ease: "power3.inOut",
        onComplete: () => {
          d.open = false;
          gsap.set(b, { clearProps: "height,opacity" });
        },
      });
    }
  };

  return (
    <details
      ref={ref}
      className="faq-item"
      data-state="closed"
      onToggle={(e) => {
        // Keep the icon in step when the browser opens it itself (find in page, reduced motion).
        const d = e.currentTarget;
        if (!gsap.isTweening(body.current))
          d.dataset.state = d.open ? "open" : "closed";
      }}
    >
      <summary onClick={toggle}>
        <span>{q}</span>
        <svg viewBox="0 0 24 24" className="faq-plus" aria-hidden="true">
          <path d="M5 12h14" />
          <path className="faq-v" d="M12 5v14" />
        </svg>
      </summary>
      <div ref={body} className="faq-body">
        <p>{a}</p>
      </div>
    </details>
  );
}

export function Faq() {
  return (
    <section id="faq" className="container-m max-w-3xl pb-24 sm:pb-32">
      <Heading eyebrow="FAQ">
        Good <em>questions</em>
      </Heading>
      <div className="faq-list" data-rv>
        {FAQ.map((item) => (
          <Item key={item.q} q={item.q} a={item.a} />
        ))}
      </div>
    </section>
  );
}
