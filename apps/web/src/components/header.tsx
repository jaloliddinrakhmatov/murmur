"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { NAV, SITE } from "../content/site.ts";
import { gsap } from "../motion/gsap.ts";
import { Magnetic } from "../motion/magnetic.tsx";
import { useMotion } from "../motion/use-motion.ts";
import "./chrome.css";
import { Logo } from "./logo.tsx";
import { MobileNav } from "./mobile-nav.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

/**
 * Glass header. At the top it is a plain row; after a little scroll it condenses into a floating
 * pill (the outer box keeps its height, so nothing below moves). A thin ember line tracks the
 * scroll position, and a soft highlight slides between the desktop links.
 */
export function Header() {
  const [condensed, setCondensed] = useState(false);
  const progress = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const hover = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setCondensed(window.scrollY > 24);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  useMotion(() => {
    const line = progress.current;
    if (!line) return;
    gsap.to(line, {
      scaleX: 1,
      ease: "none",
      scrollTrigger: {
        trigger: document.documentElement,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.3,
      },
    });
  }, progress);

  function highlight(el: HTMLElement | null) {
    const h = hover.current;
    const n = nav.current;
    if (!h || !n) return;
    if (!el) {
      h.style.opacity = "0";
      return;
    }
    const a = el.getBoundingClientRect();
    const b = n.getBoundingClientRect();
    h.style.width = `${a.width}px`;
    h.style.transform = `translateX(${a.left - b.left}px)`;
    h.style.opacity = "1";
  }

  return (
    <header className="sticky top-0 z-40 h-16">
      <div ref={progress} className="scroll-line" aria-hidden="true" />
      <div className="site-bar relative" data-condensed={condensed}>
        <div className="flex h-full items-center justify-between gap-4 px-5 sm:px-8">
          <Logo intro />
          <nav
            ref={nav}
            aria-label="Main"
            className="relative hidden items-center gap-1 lg:flex"
            onPointerLeave={() => highlight(null)}
            onBlur={() => highlight(null)}
          >
            <span ref={hover} className="nav-hover" aria-hidden="true" />
            {NAV.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onPointerEnter={(e) => highlight(e.currentTarget)}
                onFocus={(e) => highlight(e.currentTarget)}
                className="relative rounded-full px-3.5 py-2 text-[0.9375rem] font-medium text-muted transition-colors hover:text-fg focus-visible:text-fg"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            <Magnetic className="hidden sm:inline-block">
              <Link href={SITE.cta.href} className="btn btn-primary !min-h-10">
                {SITE.cta.label}
              </Link>
            </Magnetic>
            <MobileNav />
          </div>
        </div>
      </div>
    </header>
  );
}
