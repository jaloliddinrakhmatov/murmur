import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "./cn.ts";
import { Tooltip } from "./tooltip.tsx";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "accent"
  | "banner"
  | "soft";
export type ButtonSize = "sm" | "md" | "lg";

// Measured from the reference: ink primary (“Add new”), warm filled secondary (“Change”),
// outlined (“Connect”); disabled primary turns flat grey rather than translucent.
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-disabled disabled:text-primary-fg",
  secondary:
    "bg-surface-strong text-fg hover:bg-hairline-strong disabled:opacity-50",
  outline:
    "bg-sheet text-fg shadow-[inset_0_0_0_1px_var(--m-hairline)] hover:bg-surface disabled:opacity-50",
  ghost: "text-fg hover:bg-surface-hover disabled:opacity-50",
  danger:
    "text-danger shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] hover:bg-danger-soft disabled:opacity-50",
  accent:
    "bg-accent text-fg-on-accent hover:bg-accent-hover disabled:opacity-50",
  // Light button on banner artwork (reference “Get started”, “Add new word”).
  banner: "bg-modal/90 text-fg hover:bg-modal disabled:opacity-50",
  // Peach pill (reference “Start Notetaker”).
  soft: "bg-accent-soft text-fg hover:brightness-[0.97] disabled:opacity-50",
};

// Reference buttons are 36 pt with 8 pt corners and 16 pt side padding (md).
const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-md px-3 text-ui",
  md: "h-9 gap-2 rounded-md px-4 text-ui",
  lg: "h-10 gap-2 rounded-md px-5 text-ui",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button while an action runs. */
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading = false,
      icon,
      className,
      children,
      disabled,
      type = "button",
      ...props
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        data-variant={variant}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(
          "no-drag inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium transition-colors duration-[var(--m-duration-fast)] disabled:pointer-events-none",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...props}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          icon
        )}
        {children}
      </button>
    );
  },
);

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  /** Required: used for aria-label and the tooltip. */
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
  active?: boolean;
  tooltip?: boolean;
  tooltipSide?: "top" | "right" | "bottom" | "left";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      label,
      icon,
      size = "md",
      active = false,
      tooltip = true,
      tooltipSide = "bottom",
      className,
      type = "button",
      ...props
    },
    ref,
  ) {
    const button = (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active || undefined}
        className={cn(
          "no-drag inline-flex shrink-0 items-center justify-center rounded-md text-fg-secondary transition-colors duration-[var(--m-duration-fast)] hover:bg-surface-hover hover:text-fg disabled:pointer-events-none disabled:opacity-45",
          size === "sm" ? "size-8" : "size-9",
          active && "bg-surface-active text-fg",
          className,
        )}
        {...props}
      >
        {icon}
      </button>
    );
    return tooltip ? (
      <Tooltip content={label} side={tooltipSide}>
        {button}
      </Tooltip>
    ) : (
      button
    );
  },
);
