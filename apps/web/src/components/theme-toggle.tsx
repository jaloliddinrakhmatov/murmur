"use client";

import { useId } from "react";

const KEY = "murmur.theme";

/**
 * Flips between light and dark; the first visit follows the system (see the script in layout).
 * The icon shows the theme you would switch to and morphs between moon and sun (chrome.css).
 */
export function ThemeToggle() {
  const mask = useId();

  function toggle() {
    const root = document.documentElement;
    const dark = getComputedStyle(root).colorScheme === "dark";
    const next = dark ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice just lasts for this visit */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Switch colour theme"
      className="theme-btn grid size-10 place-items-center rounded-full text-muted transition-colors hover:bg-surface-strong hover:text-fg"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <mask id={mask}>
          <rect width="24" height="24" fill="#fff" />
          <circle className="tt-cut" cx="19" cy="5" r="7" fill="#000" />
        </mask>
        <circle
          className="tt-body"
          cx="12"
          cy="12"
          r="9"
          fill="currentColor"
          mask={`url(#${mask})`}
        />
        <g
          className="tt-rays"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M12 1.5v2.2M12 20.3v2.2M1.5 12h2.2M20.3 12h2.2M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5" />
        </g>
      </svg>
    </button>
  );
}
