// Single-choice cards (reference: Style → Auto cleanup levels). A radio group: one card is
// selected (1 pt ink border), arrow keys move the selection, Space/Enter or a click selects.
import { useRef, type ReactNode } from "react";
import { cn } from "./cn.ts";
import { moveSelection } from "./roving.ts";

export interface ChoiceOption<T extends string> {
  value: T;
  title: ReactNode;
  description: ReactNode;
  /** Pinned to the bottom of the card (e.g. an example). */
  footer?: ReactNode;
}

export function ChoiceCards<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: ChoiceOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const values = options.map((o) => o.value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid grid-cols-3 gap-4 max-[1000px]:grid-cols-1"
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
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => moveSelection(e, i, values, onChange, refs)}
            className={cn(
              "no-drag flex min-h-[360px] flex-col rounded-card bg-sheet p-3 text-left transition-shadow duration-[var(--m-duration-fast)] disabled:opacity-60 max-[1000px]:min-h-0",
              active
                ? "shadow-[inset_0_0_0_1px_var(--m-fg)]"
                : "shadow-[inset_0_0_0_1px_var(--m-hairline)] hover:shadow-[inset_0_0_0_1px_var(--m-hairline-strong)]",
            )}
          >
            <span className="font-serif text-card tracking-[-0.01em] text-fg">
              {o.title}
            </span>
            <span className="mt-2 text-ui text-fg-secondary">
              {o.description}
            </span>
            {o.footer && <span className="mt-auto block pt-6">{o.footer}</span>}
          </button>
        );
      })}
    </div>
  );
}
