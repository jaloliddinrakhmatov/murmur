"use client";

import { useEffect, useState, type RefObject } from "react";

/** True while the element is (nearly) on screen. Used to pause ambient work that nobody can see. */
export function useInView(
  ref: RefObject<Element | null>,
  rootMargin = "120px 0px",
): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries.some((e) => e.isIntersecting)),
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}
