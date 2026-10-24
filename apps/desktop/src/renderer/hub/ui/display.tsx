// Presentational primitives: status, badges, rows, settings groups, empty states, keys, skeletons.
import {
  Children,
  Fragment,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "./cn.ts";
import { moveSelection } from "./roving.ts";

import type { Tone } from "../model/tone.ts";

export type { Tone };

const DOT: Record<Tone, string> = {
  neutral: "bg-fg-tertiary",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};
const TEXT: Record<Tone, string> = {
  neutral: "text-fg-secondary",
  accent: "text-accent-text",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};
const SOFT: Record<Tone, string> = {
  neutral: "bg-surface text-fg-secondary",
  accent: "bg-accent-soft text-accent-text",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};

export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-caption font-medium",
        TEXT[tone],
        className,
      )}
    >
      <span
        className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])}
        aria-hidden
      />
      {label}
    </span>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm px-1.5 text-caption font-medium",
        SOFT[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Uppercase letter-spaced micro label (verified pattern: "TOTAL WORDS"). */
export function MicroLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-micro font-medium uppercase text-fg-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Shown on hover/focus only, so dense lists stay quiet. */
  actions?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
}

/**
 * A 53 pt row inside a `ListGroup` (reference list rows). The row's own action is a real
 * <button> covering the content; `actions` and `trailing` sit beside it (never inside), so
 * each control is separately focusable and clicks don't bubble.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  actions,
  selected,
  onClick,
  label,
}: ListRowProps & { label?: string }) {
  const content = (
    <>
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-ui text-fg">{title}</div>
        {subtitle && (
          <div className="mt-0.5 truncate text-caption text-fg-secondary">
            {subtitle}
          </div>
        )}
      </div>
    </>
  );
  return (
    <div
      className={cn(
        "group flex min-h-[53px] items-center gap-2 pr-3 transition-colors duration-[var(--m-duration-fast)]",
        onClick && "hover:bg-surface",
        selected && "bg-surface-active",
      )}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={selected || undefined}
          className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2 pl-4 text-left focus-visible:outline-offset-[-2px]"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4">
          {content}
        </div>
      )}
      {actions && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--m-duration-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
          {actions}
        </div>
      )}
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}

/**
 * Bordered list (reference): sheet-coloured, 1 pt hairline edge, 16 pt corners, hairline
 * dividers between rows. Children are the rows (usually `<li>` around a `ListRow`).
 */
export function ListGroup({
  label,
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <ul
      aria-label={label}
      className={cn(
        "divide-y divide-hairline overflow-hidden rounded-list border border-hairline bg-sheet",
        className,
      )}
    >
      {children}
    </ul>
  );
}

/** Grouped settings rows on a warm card with inset dividers (reference: 14 pt corners, 20 pt padding). */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <section className="space-y-2">
      {(title || description) && (
        <header className="space-y-0.5 px-0.5 pt-2">
          {title && <h3 className="text-ui font-semibold text-fg">{title}</h3>}
          {description && (
            <p className="text-caption text-fg-secondary">{description}</p>
          )}
        </header>
      )}
      <div className="rounded-card bg-surface px-5">
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <div className="h-px bg-hairline" />}
            {row}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

/** Id of a row's description, for the control's aria-describedby. */
export const describedBy = (id: string) => `${id}-desc`;

/**
 * Label and description on the left, control on the right. With `htmlFor`, the label targets
 * the control and the description gets `describedBy(htmlFor)`. Wraps the control below the
 * text when the sheet is narrow.
 */
export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  describes,
  align = "center",
}: {
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  htmlFor?: string;
  /** Id of a control that can't take a <label> (e.g. a segmented control); links the description. */
  describes?: string;
  align?: "center" | "start";
}) {
  const descId = htmlFor ?? describes;
  return (
    <div
      className={cn(
        // Reference rows: 20 pt padding, title and description 6 pt apart (86 pt with both).
        "flex min-h-16 flex-wrap gap-x-6 gap-y-2 py-5",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      <div className="min-w-48 flex-1">
        {htmlFor ? (
          <label
            htmlFor={htmlFor}
            className="block text-ui font-medium text-fg"
          >
            {label}
          </label>
        ) : (
          <div className="text-ui font-medium text-fg">{label}</div>
        )}
        {description && (
          <div
            id={descId ? describedBy(descId) : undefined}
            className="mt-1.5 text-ui text-fg-secondary"
          >
            {description}
          </div>
        )}
      </div>
      {control && (
        <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          {control}
        </div>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-surface-strong text-fg">
          {icon}
        </div>
      )}
      <h3 className="font-serif text-empty text-fg">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-md text-ui text-fg-secondary">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** Grey track with a white raised thumb (verified pattern); arrow keys move the selection. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  describedBy: descId,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  describedBy?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const values = options.map((o) => o.value);
  const onKey = (e: KeyboardEvent, i: number) =>
    moveSelection(e, i, values, onChange, refs);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={descId}
      className="no-drag inline-flex h-9 items-center gap-0.5 rounded-md bg-surface-strong p-0.5"
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "h-8 rounded-[6px] px-3.5 text-ui font-medium transition-colors duration-[var(--m-duration-fast)]",
              active
                ? "bg-modal text-fg shadow-raised"
                : "text-fg hover:bg-hairline-strong",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

const KEY_SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  command: "⌘",
  ctrl: "⌃",
  control: "⌃",
  opt: "⌥",
  option: "⌥",
  alt: "⌥",
  shift: "⇧",
  fn: "fn",
  space: "Space",
  escape: "esc",
  esc: "esc",
  return: "↩",
  enter: "↩",
  tab: "⇥",
};

/** Renders "ctrl+opt+space" as ⌃ ⌥ Space keycaps. */
export function Kbd({
  combo,
  className,
  size = "md",
  active = false,
}: {
  combo: string;
  className?: string;
  /** Lights the keys (the shortcut is being held). */
  active?: boolean;
  /** `lg`: inside a 24 pt title, ember-tinted (the reference's highlighted key in the greeting). */
  size?: "md" | "lg";
}) {
  const keys = combo
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => KEY_SYMBOLS[k.toLowerCase()] ?? k.toUpperCase());
  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      aria-label={combo}
    >
      {keys.map((k, i) => (
        <kbd
          key={i}
          className={cn(
            "inline-flex items-center justify-center font-sans font-medium text-fg transition-colors",
            active &&
              "!bg-accent-soft !shadow-[inset_0_0_0_1.5px_var(--m-accent)]",
            size === "lg"
              ? "h-8 min-w-8 rounded-sm bg-accent-soft px-2 text-lead shadow-[inset_0_0_0_1px_var(--m-accent)]"
              : "h-6 min-w-6 rounded-xs bg-surface px-1.5 text-caption shadow-[inset_0_0_0_1px_var(--m-hairline-strong)]",
          )}
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Page-level notice strip: an error with a retry, or a setting that affects this screen. */
export function InlineAlert({
  tone,
  icon,
  children,
  action,
}: {
  tone: "danger" | "warning";
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-center gap-3 rounded-card px-4 py-3",
        tone === "danger" ? "bg-danger-soft" : "bg-warning-soft",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 [&>svg]:size-4",
          tone === "danger" ? "text-danger" : "text-warning",
        )}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 text-ui text-fg">{children}</div>
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-surface", className)}
      aria-hidden
    />
  );
}
