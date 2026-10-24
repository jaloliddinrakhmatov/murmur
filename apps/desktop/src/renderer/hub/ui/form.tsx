import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown, Search, X } from "lucide-react";
import * as RadixSwitch from "@radix-ui/react-switch";
import { cn } from "./cn.ts";

// White fields with a hairline edge, 8 pt corners (reference inputs and selects).
const FIELD =
  "no-drag rounded-md bg-modal text-ui text-fg placeholder:text-fg-tertiary shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] transition-shadow duration-[var(--m-duration-fast)] outline-none focus:shadow-[inset_0_0_0_1px_var(--m-accent),0_0_0_3px_var(--m-focus)] disabled:opacity-50 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--m-danger)]";

/** Full width unless the caller sets a width (both would otherwise be in the class list). */
const withWidth = (className?: string) =>
  /(^|\s)(max-)?w-/.test(className ?? "") &&
  !/(^|\s)max-w-/.test(className ?? "")
    ? className
    : cn("w-full", className);

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(FIELD, "h-9 px-3", withWidth(className))}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        FIELD,
        "min-h-24 w-full resize-y px-3 py-2.5 leading-[22px]",
        className,
      )}
      {...props}
    />
  );
});

export interface SearchInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value"
> {
  value: string;
  onValueChange: (value: string) => void;
  ref?: Ref<HTMLInputElement>;
}

/** Search field with a leading magnifier and a clear button; Esc clears. */
export function SearchInput({
  value,
  onValueChange,
  className,
  placeholder = "Search",
  ref,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn("relative w-full", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-secondary"
        aria-hidden
      />
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onValueChange("");
          }
        }}
        className={cn(
          FIELD,
          "h-9 w-full pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden",
        )}
        {...props}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={(e) => {
            onValueChange("");
            // The clear button disappears with the text; keep focus in the field.
            (
              e.currentTarget.previousElementSibling as HTMLElement | null
            )?.focus();
          }}
          className="no-drag absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-fg-secondary hover:bg-surface-hover hover:text-fg"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Native select (keeps macOS menus and keyboard behavior) with Murmur styling. */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <div className={cn("relative", withWidth(className))}>
      <select
        ref={ref}
        className={cn(FIELD, "h-10 w-full appearance-none pl-3 pr-9")}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg"
        aria-hidden
      />
    </div>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  id?: string;
  describedBy?: string;
}

/**
 * 42 × 22 pt toggle (measured): ink track when on; the reference's light off track
 * (`switch-off`) with a 1 pt `switch-off-edge` outline, so the off control keeps 3:1 contrast
 * against its panel (WCAG 1.4.11) without changing its look.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  id,
  describedBy,
}: SwitchProps) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
      className="no-drag relative inline-flex h-[22px] w-[42px] shrink-0 cursor-default items-center rounded-full bg-switch-off shadow-[inset_0_0_0_1px_var(--m-switch-off-edge)] transition-colors duration-[var(--m-duration-fast)] disabled:opacity-45 data-[state=checked]:bg-primary data-[state=checked]:shadow-none"
    >
      <RadixSwitch.Thumb className="block size-[18px] translate-x-0.5 rounded-full bg-switch-thumb shadow-raised transition-transform duration-[var(--m-duration-fast)] ease-out data-[state=checked]:translate-x-[22px] data-[state=checked]:bg-primary-fg" />
    </RadixSwitch.Root>
  );
}

/** Label + control + hint, with ids wired for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-ui font-medium text-fg">
        {label}
      </label>
      {children({ id, describedBy: hint || error ? hintId : undefined })}
      {(error || hint) && (
        <p
          id={hintId}
          aria-live="polite"
          className={cn(
            "text-caption",
            error ? "text-danger" : "text-fg-secondary",
          )}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
