// Illustrations and example panels for first-run setup, drawn for Murmur in its own palette
// (pill-and-dot mark, ember accent). Decorative: every one is hidden from assistive technology,
// and mock interfaces say "Example" so nobody mistakes them for their own data.
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "../ui/index.ts";

/** Voice becoming text: a pill-shaped mark, sound bars and lines of text. */
export function ArtVoice() {
  return (
    <svg viewBox="0 0 420 320" className="w-full max-w-[460px]" aria-hidden>
      <rect
        x="40"
        y="244"
        width="340"
        height="10"
        rx="5"
        className="fill-surface-strong"
      />
      <rect
        x="70"
        y="60"
        width="200"
        height="150"
        rx="18"
        className="fill-modal stroke-fg"
        strokeWidth="2.5"
      />
      <rect x="92" y="88" width="120" height="10" rx="5" className="fill-fg" />
      <rect
        x="92"
        y="112"
        width="150"
        height="10"
        rx="5"
        className="fill-surface-strong"
      />
      <rect
        x="92"
        y="136"
        width="96"
        height="10"
        rx="5"
        className="fill-surface-strong"
      />
      <rect
        x="92"
        y="160"
        width="132"
        height="10"
        rx="5"
        className="fill-accent"
      />
      <rect x="152" y="210" width="24" height="26" className="fill-fg" />
      <rect x="116" y="232" width="96" height="12" rx="6" className="fill-fg" />
      <g transform="translate(290 90)">
        <rect width="96" height="48" rx="24" className="fill-fg" />
        <circle cx="68" cy="24" r="10" className="fill-accent" />
        <rect
          x="18"
          y="14"
          width="6"
          height="20"
          rx="3"
          className="fill-modal"
        />
        <rect
          x="30"
          y="8"
          width="6"
          height="32"
          rx="3"
          className="fill-modal"
        />
        <rect
          x="42"
          y="17"
          width="6"
          height="14"
          rx="3"
          className="fill-modal"
        />
      </g>
      <path
        d="M300 156c10 18 22 28 40 34"
        className="fill-none stroke-fg"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="1 9"
      />
      <circle cx="348" cy="196" r="22" className="fill-accent-soft" />
      <path
        d="M338 197l7 7 14-15"
        className="fill-none stroke-fg"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A person-less workspace: screen, keyboard and a note, for the "who are you" questions. */
export function ArtDesk() {
  return (
    <svg viewBox="0 0 420 320" className="w-full max-w-[460px]" aria-hidden>
      <rect
        x="30"
        y="248"
        width="360"
        height="10"
        rx="5"
        className="fill-surface-strong"
      />
      <rect
        x="110"
        y="70"
        width="200"
        height="140"
        rx="16"
        className="fill-modal stroke-fg"
        strokeWidth="2.5"
      />
      <rect
        x="130"
        y="92"
        width="160"
        height="96"
        rx="10"
        className="fill-accent-faint"
      />
      <rect
        x="146"
        y="108"
        width="70"
        height="9"
        rx="4.5"
        className="fill-accent"
      />
      <rect
        x="146"
        y="128"
        width="120"
        height="9"
        rx="4.5"
        className="fill-fg"
      />
      <rect
        x="146"
        y="148"
        width="96"
        height="9"
        rx="4.5"
        className="fill-fg"
      />
      <rect x="196" y="210" width="28" height="22" className="fill-fg" />
      <rect
        x="160"
        y="232"
        width="100"
        height="12"
        rx="6"
        className="fill-fg"
      />
      <rect
        x="318"
        y="52"
        width="70"
        height="62"
        rx="12"
        className="fill-accent-soft stroke-fg"
        strokeWidth="2.5"
        transform="rotate(6 353 83)"
      />
      <rect
        x="332"
        y="70"
        width="38"
        height="7"
        rx="3.5"
        className="fill-fg"
        transform="rotate(6 353 83)"
      />
      <rect
        x="332"
        y="86"
        width="26"
        height="7"
        rx="3.5"
        className="fill-fg"
        transform="rotate(6 353 83)"
      />
      <rect
        x="40"
        y="206"
        width="48"
        height="42"
        rx="8"
        className="fill-surface-strong"
      />
      <rect x="48" y="190" width="6" height="22" rx="3" className="fill-fg" />
      <rect
        x="62"
        y="184"
        width="6"
        height="28"
        rx="3"
        className="fill-accent"
      />
    </svg>
  );
}

/** A shield with a lock: where your data lives. */
export function ArtShield() {
  return (
    <svg viewBox="0 0 420 320" className="w-full max-w-[420px]" aria-hidden>
      <circle cx="210" cy="160" r="128" className="fill-accent-faint" />
      <path
        d="M210 52l82 30v68c0 54-34 92-82 112-48-20-82-58-82-112V82z"
        className="fill-modal stroke-fg"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect
        x="178"
        y="146"
        width="64"
        height="52"
        rx="10"
        className="fill-fg"
      />
      <path
        d="M190 146v-14a20 20 0 0140 0v14"
        className="fill-none stroke-fg"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="210" cy="170" r="7" className="fill-accent" />
      <rect
        x="205"
        y="172"
        width="10"
        height="16"
        rx="5"
        className="fill-accent"
      />
    </svg>
  );
}

/** Sound waves around a pill, for the pages that are about speaking. */
export function ArtWaves() {
  return (
    <svg viewBox="0 0 420 320" className="w-full max-w-[420px]" aria-hidden>
      <circle cx="210" cy="160" r="120" className="fill-accent-faint" />
      <circle cx="210" cy="160" r="84" className="fill-accent-soft" />
      <rect
        x="150"
        y="136"
        width="120"
        height="48"
        rx="24"
        className="fill-fg"
      />
      <circle cx="244" cy="160" r="12" className="fill-accent" />
      <rect
        x="172"
        y="148"
        width="6"
        height="24"
        rx="3"
        className="fill-modal"
      />
      <rect
        x="186"
        y="140"
        width="6"
        height="40"
        rx="3"
        className="fill-modal"
      />
      <rect
        x="200"
        y="152"
        width="6"
        height="16"
        rx="3"
        className="fill-modal"
      />
    </svg>
  );
}

/** Frame for a mock interface: labelled so it is never taken for real data. */
export function Example({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div aria-hidden className={cn("w-full max-w-[460px]", className)}>
      <p className="mb-2 text-micro uppercase text-fg-secondary">Example</p>
      {children}
    </div>
  );
}

const line = "h-2 rounded-full bg-surface-strong";

/** The two things Murmur does, as little pictures that light up when chosen. */
export function HelpPreviews({
  dictation,
  notetaker,
}: {
  dictation: boolean;
  notetaker: boolean;
}) {
  const card = (on: boolean) =>
    cn(
      "rounded-card bg-modal p-5 transition-all duration-(--m-duration-base)",
      on
        ? "shadow-[inset_0_0_0_2px_var(--m-primary)]"
        : "opacity-60 shadow-[inset_0_0_0_1px_var(--m-hairline)]",
    );
  return (
    <Example className="space-y-4">
      <div className={card(dictation)} data-selected={dictation}>
        <p className="text-ui font-semibold text-fg">Dictation</p>
        <div className="mt-3 space-y-2">
          <div className={cn(line, "w-4/5")} />
          <div className={cn(line, "w-full")} />
          <div className={cn(line, "w-3/5 bg-accent-soft")} />
        </div>
        <div className="mt-4 inline-flex h-7 items-center gap-1 rounded-full bg-primary px-3">
          {[10, 16, 8, 14].map((h, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-primary-fg"
              style={{ height: h }}
            />
          ))}
        </div>
      </div>
      <div className={card(notetaker)} data-selected={notetaker}>
        <p className="text-ui font-semibold text-fg">Notetaker</p>
        <ul className="mt-3 space-y-2.5">
          {["w-2/3", "w-5/6", "w-1/2"].map((w, i) => (
            <li key={i} className="flex items-center gap-2.5">
              <span className="size-2 shrink-0 rounded-full bg-accent" />
              <span className={cn(line, w)} />
            </li>
          ))}
        </ul>
        <p className="mt-4 text-caption text-fg-secondary">Notes and summary</p>
      </div>
    </Example>
  );
}

/** What a macOS permission prompt looks like, drawn for Murmur (not a real prompt). */
export function PromptPreview({ what }: { what: string }) {
  return (
    <Example>
      <div className="mx-auto w-[300px] rounded-xl bg-modal p-5 text-center shadow-[inset_0_0_0_1px_var(--m-hairline-strong)]">
        <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-surface-strong">
          <svg viewBox="0 0 24 24" className="size-7" aria-hidden>
            <rect
              x="2"
              y="7"
              width="20"
              height="10"
              rx="5"
              className="fill-fg"
            />
            <circle cx="16" cy="12" r="2.1" className="fill-accent" />
          </svg>
        </div>
        <p className="text-ui font-semibold text-fg">
          “Murmur” would like to {what}.
        </p>
        <p className="mt-1 text-caption text-fg-secondary">
          Murmur only listens while you hold your shortcut.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <span className="rounded-md bg-surface-strong py-1.5 text-caption text-fg">
            Don’t Allow
          </span>
          <span className="rounded-md bg-primary py-1.5 text-caption font-medium text-primary-fg">
            Allow
          </span>
        </div>
      </div>
    </Example>
  );
}

/** Meetings Notetaker could list, as an example only. */
export function CalendarPreview() {
  const rows = [
    ["Mon 10:00", "Weekly planning", "w-40"],
    ["Tue 14:30", "Design review", "w-32"],
    ["Thu 09:15", "Customer call", "w-36"],
  ];
  return (
    <Example>
      <div className="rounded-card bg-modal p-5 shadow-[inset_0_0_0_1px_var(--m-hairline)]">
        <p className="text-ui font-semibold text-fg">Upcoming</p>
        <ul className="mt-3 divide-y divide-hairline">
          {rows.map(([when, what], i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <span className="w-[76px] shrink-0 text-caption text-fg-secondary">
                {when}
              </span>
              <span className="min-w-0 flex-1 truncate text-ui text-fg">
                {what}
              </span>
              <span className="rounded-full bg-accent-soft px-2.5 py-1 text-caption text-fg">
                Take notes
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Example>
  );
}

export function DoneMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 items-center justify-center rounded-full bg-success text-primary-fg",
        className,
      )}
    >
      <Check className="size-4" />
    </span>
  );
}
