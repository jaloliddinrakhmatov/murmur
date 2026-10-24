// Layout pieces for first-run setup: the top bar with the five stages and a thin progress line,
// the two-column and centred screens, and the choice chips. Pure presentation.
import { type ReactNode, type ButtonHTMLAttributes, type Ref } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { Button, cn } from "../ui/index.ts";
import type { Stage } from "../model/onboarding.ts";

export function TopBar({
  stages,
  progress,
  night,
}: {
  /** Matches the two night screens, so the bar never contrasts with its page. */
  night?: boolean;
  stages: { id: Stage; label: string; state: "done" | "current" | "todo" }[];
  progress: number;
}) {
  return (
    <header
      className={cn(
        "drag relative flex h-(--m-titlebar-h) shrink-0 items-center justify-center border-b",
        night ? "border-night-hairline bg-night" : "border-hairline bg-sheet",
      )}
    >
      <nav aria-label="Setup progress" className="no-drag">
        <ol className="flex items-center gap-3 max-[760px]:gap-2">
          {stages.map((s, i) => (
            <li
              key={s.id}
              className="flex items-center gap-3 max-[760px]:gap-2"
            >
              {i > 0 && (
                <span aria-hidden className="text-fg-tertiary">
                  ›
                </span>
              )}
              <span
                aria-current={s.state === "current" ? "step" : undefined}
                className={cn(
                  "text-micro uppercase",
                  s.state === "current"
                    ? cn("font-semibold", night ? "text-night-fg" : "text-fg")
                    : s.state === "done"
                      ? night
                        ? "text-night-fg"
                        : "text-fg"
                      : night
                        ? "text-night-fg-secondary"
                        : "text-fg-secondary",
                  s.state !== "current" && "max-[760px]:sr-only",
                )}
              >
                {s.label}
                {s.state === "done" && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          ))}
        </ol>
      </nav>
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-[-1px] h-[2px] bg-transparent"
      >
        <div
          data-progress={progress.toFixed(2)}
          className="h-full bg-accent transition-[width] duration-(--m-duration-slow) ease-(--m-ease-out)"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </header>
  );
}

export function BackLink({
  onBack,
  dark,
}: {
  onBack?: () => void;
  dark?: boolean;
}) {
  if (!onBack) return <span />;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<ArrowLeft className="size-4" aria-hidden />}
      onClick={onBack}
      className={cn(
        "-ml-3",
        dark ? "!text-night-fg hover:!bg-night-fg/10" : "text-fg-secondary",
      )}
    >
      Back
    </Button>
  );
}

export function Heading({
  children,
  className,
  center,
}: {
  children: ReactNode;
  className?: string;
  center?: boolean;
}) {
  return (
    <h1
      data-step-heading
      tabIndex={-1}
      className={cn(
        "font-serif text-banner tracking-[-0.01em] outline-none",
        center && "text-center",
        className,
      )}
    >
      {children}
    </h1>
  );
}

/** Two columns: the question on the sheet, a picture or live preview on canvas. */
export function SplitScreen({
  title,
  lead,
  onBack,
  art,
  children,
  footer,
  artLabel,
}: {
  title: ReactNode;
  lead?: ReactNode;
  onBack?: () => void;
  art: ReactNode;
  /** Shown to assistive technology only when the panel says something (a preview). */
  artLabel?: string;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] max-[860px]:grid-cols-1">
      <section className="flex min-h-0 flex-col bg-sheet">
        <div className="min-h-0 flex-1 overflow-y-auto px-14 pb-6 pt-6 [scrollbar-gutter:stable] max-[1000px]:px-8">
          <div className="mx-auto w-full max-w-[460px]">
            <BackLink onBack={onBack} />
            <div className="mt-8 animate-fade-in space-y-4">
              <Heading>{title}</Heading>
              {lead && <p className="text-lead text-fg-secondary">{lead}</p>}
              <div className="pt-2">{children}</div>
            </div>
          </div>
        </div>
        <div className="shrink-0 px-14 pb-8 pt-2 max-[1000px]:px-8">
          <div className="mx-auto w-full max-w-[460px]">{footer}</div>
        </div>
      </section>
      <aside
        aria-label={artLabel}
        aria-hidden={artLabel ? undefined : true}
        className="flex items-center justify-center overflow-hidden bg-canvas p-8 max-[860px]:hidden"
      >
        {art}
      </aside>
    </div>
  );
}

/** Soft shapes on canvas, drawn for Murmur (the app's pill-and-dot mark, enlarged and repeated). */
export function Pattern() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1200 800"
    >
      <g className="fill-surface-hover">
        <rect
          x="-120"
          y="560"
          width="620"
          height="260"
          rx="130"
          transform="rotate(-18 190 690)"
        />
        <circle cx="330" cy="700" r="46" className="fill-surface-active" />
        <rect
          x="760"
          y="-60"
          width="620"
          height="260"
          rx="130"
          transform="rotate(-18 1070 70)"
        />
        <circle cx="1130" cy="110" r="46" className="fill-surface-active" />
        <rect
          x="-200"
          y="80"
          width="520"
          height="220"
          rx="110"
          transform="rotate(14 60 190)"
        />
        <rect
          x="880"
          y="560"
          width="520"
          height="220"
          rx="110"
          transform="rotate(14 1140 670)"
        />
      </g>
    </svg>
  );
}

/** A centred card on the patterned background; `dark` is the high-contrast variant. */
export function CenterScreen({
  title,
  lead,
  onBack,
  onSkip,
  children,
  dark,
}: {
  title: ReactNode;
  lead?: ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  children?: ReactNode;
  dark?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col overflow-hidden",
        dark ? "bg-night text-night-fg" : "bg-canvas text-fg",
      )}
    >
      {!dark && <Pattern />}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-14 pb-10 pt-6 [scrollbar-gutter:stable] max-[760px]:px-6">
        <div className="flex items-center justify-between">
          <BackLink onBack={onBack} dark={dark} />
          {onSkip && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(dark && "!text-night-fg hover:!bg-night-fg/10")}
              onClick={onSkip}
            >
              Skip
            </Button>
          )}
        </div>
        <div className="mx-auto flex w-full max-w-[680px] flex-1 flex-col items-center pt-6 animate-fade-in">
          <Heading center>{title}</Heading>
          {lead && (
            <p
              className={cn(
                "mt-3 max-w-[520px] text-center text-lead",
                dark ? "text-night-fg-secondary" : "text-fg-secondary",
              )}
            >
              {lead}
            </p>
          )}
          <div className="mt-8 w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}

/** A toggle button: choices are not radios because several can be on at once. */
export function Chip({
  selected,
  icon,
  children,
  className,
  ...rest
}: {
  selected: boolean;
  icon?: ReactNode;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button
      type="button"
      data-chip
      aria-pressed={selected}
      {...rest}
      className={cn(
        "no-drag inline-flex min-h-11 items-center gap-2 rounded-md px-4 py-2 text-left text-ui transition-colors",
        selected
          ? "bg-accent-faint text-fg shadow-[inset_0_0_0_1.5px_var(--m-primary)]"
          : "bg-sheet text-fg shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] hover:bg-surface",
        className,
      )}
    >
      {icon && (
        <span aria-hidden className="shrink-0 text-fg-secondary">
          {icon}
        </span>
      )}
      {children}
      {selected && <Check aria-hidden className="size-4 shrink-0 text-fg" />}
    </button>
  );
}

export function ChipGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap gap-2.5", className)}
    >
      {children}
    </div>
  );
}

/** Full-width bottom button of a two-column screen. */
export function ContinueButton({
  onClick,
  disabled,
  children = "Continue",
  loading,
  buttonRef,
}: {
  onClick: () => void;
  disabled?: boolean;
  children?: ReactNode;
  loading?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Button
      ref={buttonRef}
      variant="primary"
      size="lg"
      className="w-full"
      disabled={disabled}
      loading={loading}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
