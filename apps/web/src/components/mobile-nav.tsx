"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { NAV, SITE } from "../content/site.ts";

/** Hamburger that morphs into an X, and a glass sheet that eases in. Closed content is inert. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (event: PointerEvent) => {
      const t = event.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t))
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
        className="burger-btn grid size-10 place-items-center rounded-full hover:bg-surface-strong"
      >
        <svg
          className="burger"
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line className="burger-1" x1="4" y1="8" x2="20" y2="8" />
          <line className="burger-2" x1="4" y1="16" x2="20" y2="16" />
        </svg>
      </button>
      <nav
        ref={panel}
        id={panelId}
        aria-label="Mobile"
        data-open={open}
        inert={!open}
        className="menu-sheet absolute inset-x-0 top-[calc(100%+0.5rem)] rounded-3xl bg-canvas/85 px-5 pt-2 pb-5 shadow-window backdrop-blur-xl"
      >
        <ul className="flex flex-col">
          {NAV.map((link, i) => (
            <li key={link.href} style={{ ["--i" as string]: i }}>
              <Link
                href={link.href}
                onClick={() => setOpen(false)}
                className="block border-b border-hairline py-3.5 text-lg font-medium"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <Link
          href={SITE.cta.href}
          onClick={() => setOpen(false)}
          className="btn btn-primary mt-5 w-full"
        >
          {SITE.cta.label}
        </Link>
      </nav>
    </div>
  );
}
