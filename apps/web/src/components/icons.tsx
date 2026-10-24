import type { ReactNode } from "react";
import type { IconName } from "../content/features.ts";

const PATHS: Record<IconName, ReactNode> = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  wand: (
    <>
      <path d="M5 19 15.5 8.5" />
      <path d="m14 4 .8 2.2L17 7l-2.2.8L14 10l-.8-2.2L11 7l2.2-.8zM19 12l.6 1.4L21 14l-1.4.6L19 16l-.6-1.4L17 14l1.4-.6z" />
    </>
  ),
  brush: (
    <>
      <path d="M4 20c3 0 4.5-1.2 4.5-3a2.5 2.5 0 0 0-2.5-2.5C4.2 14.5 4 16.5 4 20Z" />
      <path d="M8.5 14.5 18.6 4.4a1.9 1.9 0 0 1 2.7 2.7L11.2 17.2" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z" />
      <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 8h6" />
    </>
  ),
  rewrite: (
    <>
      <path d="M4 7h10M4 12h6M4 17h8" />
      <path d="m15 15 4.5-4.5 2 2L17 17h-2z" />
    </>
  ),
  pad: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M8 9h8M8 13h8M8 17h4" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.4-3 2.6-4.8 5.5-4.8s5.1 1.8 5.5 4.8" />
      <path d="M16 5.6a3 3 0 0 1 0 5.8M17.5 14.6c1.8.5 3 2 3.3 4.4" />
    </>
  ),
  command: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3" />
      <path d="m8 10 2.5 2L8 14M13 14h3.5" />
    </>
  ),
  code: <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 5l-3 14" />,
  plug: (
    <>
      <path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z" />
      <path d="M12 17v4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5S9.6 5.9 12 3.5Z" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4.5v4h4" />
      <path d="M12 8v4.2l2.8 1.8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="3" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="3" />
      <path d="m4.5 8 7.5 5.5L19.5 8" />
    </>
  ),
  chat: (
    <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-6.5L8 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5Z" />
  ),
  doc: (
    <>
      <path d="M7 3.5h7.5L19 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5V8h5M9 13h6M9 16.5h4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="m7.5 10 3 2.5-3 2.5M13 15h3.5" />
    </>
  ),
  browser: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M3.5 9h17M6.8 6.8h.01M9.3 6.8h.01" />
    </>
  ),
  notes: (
    <>
      <path d="M6 3.5h12a1 1 0 0 1 1 1V15l-5 5.5H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
      <path d="M9 8.5h6M9 12h4M14 20.5V16h5" />
    </>
  ),
  board: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.2 8v8M14.8 8v5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  gift: (
    <>
      <rect x="4" y="9" width="16" height="11" rx="2.5" />
      <path d="M3.5 9h17M12 9v11M12 9c-1.5-4-5.5-4-5.5-1.6C6.5 9 9 9 12 9Zm0 0c1.5-4 5.5-4 5.5-1.6C17.5 9 15 9 12 9Z" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />,
  pen: (
    <path d="m4 20 1-4.5L16.5 4a2 2 0 0 1 3 3L8 18.5 4 20ZM14 6.5l3.5 3.5" />
  ),
  chart: <path d="M4 20V4M4 20h16M8 16v-4M12.5 16V8M17 16v-6" />,
};

export function Icon({
  name,
  size = 22,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
