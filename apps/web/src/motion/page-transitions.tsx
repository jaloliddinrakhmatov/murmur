"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { REDUCED_MOTION, ScrollTrigger, gsap } from "./gsap.ts";

type Doc = Document & {
  startViewTransition?: (update: () => Promise<void>) => unknown;
};

// Matches `scroll-padding-top` in globals.css, so a section lands below the floating header.
const HEADER_OFFSET = 80;

function sectionTop(hash: string): number | null {
  const id = decodeURIComponent(hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  return el
    ? el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET
    : null;
}

/**
 * Hash links scroll in at most ~0.8 s whatever the distance. The browser's own smooth scroll
 * crawls through the home page's long pinned sections and plays every scroll scene on the way.
 */
function scrollToHash(hash: string, smooth: boolean) {
  const top = sectionTop(hash);
  if (top === null) return;
  gsap.killTweensOf(window);
  if (!smooth) {
    window.scrollTo({ top, behavior: "instant" });
    return;
  }
  const distance = Math.abs(top - window.scrollY);
  gsap.to(window, {
    duration: Math.min(0.8, 0.3 + distance / 30000),
    ease: "power3.inOut",
    scrollTo: { y: top, autoKill: true },
  });
}

/**
 * Lands on a section once the page is laid out: pinned scroll scenes add their spacers when they
 * are set up, so the position is measured after a refresh and corrected once more shortly after
 * (fonts and split headings can still shift it).
 */
function landOnHash(hash: string) {
  ScrollTrigger.refresh();
  scrollToHash(hash, false);
  setTimeout(() => {
    const top = sectionTop(hash);
    if (top !== null && Math.abs(top - window.scrollY) > 4)
      scrollToHash(hash, false);
  }, 350);
}

/**
 * PageTransitions: internal navigation. Links to a section scroll there quickly, also when they
 * come from another page. Where the browser has the View Transitions API, moving between pages
 * crossfades (see ::view-transition rules in globals.css). Modified clicks, new tabs, downloads
 * and back/forward behave as before; with reduced motion nothing animates.
 */
export function PageTransitions() {
  const router = useRouter();
  const pathname = usePathname();
  const settle = useRef<(() => void) | null>(null);
  const pendingHash = useRef<string | null>(null);

  useEffect(() => {
    const done = settle.current;
    const hash = pendingHash.current;
    settle.current = null;
    pendingHash.current = null;
    if (!done && !hash) return;
    // The new route has rendered. A view transition holds animation frames until it is told the
    // page is ready, but timers still run: place the page (and its section) here, then release
    // the transition so it captures the finished "after" frame.
    setTimeout(() => {
      if (hash) {
        history.replaceState(history.state, "", hash);
        landOnHash(hash);
      }
      done?.();
    }, 0);
  }, [pathname]);

  useEffect(() => {
    // A page opened with a section in its address (a typed or shared link).
    const hash = location.hash;
    if (hash) setTimeout(() => landOnHash(hash), 0);
  }, []);

  useEffect(() => {
    const doc = document as Doc;
    const reduce = window.matchMedia(REDUCED_MOTION);

    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      )
        return;
      const a = (e.target as Element).closest?.("a");
      if (
        !a ||
        a.target ||
        a.hasAttribute("download") ||
        a.origin !== location.origin
      )
        return;

      if (a.pathname === location.pathname && a.search === location.search) {
        if (!a.hash) return;
        e.preventDefault();
        if (a.hash !== location.hash)
          history.pushState(history.state, "", a.hash);
        scrollToHash(a.hash, !reduce.matches);
        return;
      }

      e.preventDefault();
      pendingHash.current = a.hash || null;
      const go = () => router.push(a.pathname + a.search);
      if (!doc.startViewTransition || reduce.matches) {
        go();
        return;
      }
      doc.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            settle.current = resolve;
            setTimeout(() => {
              if (settle.current === resolve) {
                settle.current = null;
                resolve();
              }
            }, 1500);
            go();
          }),
      );
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);

  return null;
}
