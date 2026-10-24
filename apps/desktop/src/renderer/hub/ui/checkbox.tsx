// A native checkbox (keyboard, form and screen-reader behaviour for free) drawn in Murmur's
// style: 18 pt, ink when checked, the off-switch outline when not.
import { useId, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "./cn.ts";

export function Checkbox({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <span className="relative mt-px flex size-[18px] shrink-0">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={description ? `${id}-desc` : undefined}
          onChange={(e) => onCheckedChange(e.target.checked)}
          className={cn(
            "no-drag peer size-[18px] appearance-none rounded-[5px] transition-colors disabled:opacity-50",
            checked
              ? "bg-primary"
              : "bg-modal shadow-[inset_0_0_0_1.5px_var(--m-switch-off-edge)]",
          )}
        />
        {checked && (
          <Check
            className="pointer-events-none absolute inset-0 m-auto size-3.5 stroke-[2.5] text-primary-fg"
            aria-hidden
          />
        )}
      </span>
      <span className="min-w-0">
        <label htmlFor={id} className="block text-ui font-medium text-fg">
          {label}
        </label>
        {description && (
          <span
            id={`${id}-desc`}
            className="mt-0.5 block text-ui text-fg-secondary"
          >
            {description}
          </span>
        )}
      </span>
    </div>
  );
}
