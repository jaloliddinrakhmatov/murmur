// Underlined tabs (reference: Dictionary, Insights, Style): 15 pt labels 24 pt apart, the
// selected one in ink with a 2 pt underline, a hairline under the row, optional tools on the
// right. They filter or switch content in place, so they are a radio group like the
// segmented control (same keyboard behaviour), not a tablist of separate panels.
import { useRef, type ReactNode } from "react";
import { cn } from "./cn.ts";
import { moveSelection } from "./roving.ts";

export interface TabOption<T extends string> {
  value: T;
  label: ReactNode;
  badge?: ReactNode;
}

export function UnderlineTabs<T extends string>({
  options,
  value,
  onChange,
  label,
  tools,
}: {
  options: TabOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  /** Right-aligned controls on the same row (search, menus). */
  tools?: ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const values = options.map((o) => o.value);
  return (
    <div className="flex items-end gap-4 border-b border-hairline">
      <div
        role="radiogroup"
        aria-label={label}
        className="no-drag flex min-w-0 flex-1 items-end gap-6"
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
              onKeyDown={(e) => moveSelection(e, i, values, onChange, refs)}
              className={cn(
                "relative -mb-px flex h-10 items-center gap-2 text-ui transition-colors duration-[var(--m-duration-fast)] focus-visible:outline-offset-0",
                active
                  ? "font-medium text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-fg"
                  : "text-fg-secondary hover:text-fg",
              )}
            >
              {o.label}
              {o.badge}
            </button>
          );
        })}
      </div>
      {tools && (
        <div className="flex shrink-0 items-center gap-1 pb-1">{tools}</div>
      )}
    </div>
  );
}
