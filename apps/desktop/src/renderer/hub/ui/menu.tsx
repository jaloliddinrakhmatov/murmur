import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn.ts";

export const Menu = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
export const MenuRadioGroup = RadixMenu.RadioGroup;

const ITEM =
  "relative flex h-8 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-ui text-fg outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-surface-hover";

export function MenuContent({
  children,
  align = "end",
  className,
  onCloseAutoFocus,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
  /** Prevent the default to keep focus where a dialog opened by an item put it. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <RadixMenu.Portal>
      <RadixMenu.Content
        align={align}
        onCloseAutoFocus={onCloseAutoFocus}
        sideOffset={6}
        className={cn(
          "z-50 min-w-48 animate-popover-in rounded-xl bg-modal p-1.5 shadow-popover",
          className,
        )}
      >
        {children}
      </RadixMenu.Content>
    </RadixMenu.Portal>
  );
}

export function MenuItem({
  children,
  icon,
  destructive,
  onSelect,
  disabled,
  className,
}: {
  children: ReactNode;
  icon?: ReactNode;
  destructive?: boolean;
  onSelect?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <RadixMenu.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(ITEM, destructive && "text-danger", className)}
    >
      {icon && (
        <span className="flex size-4 items-center justify-center text-fg-secondary">
          {icon}
        </span>
      )}
      {children}
    </RadixMenu.Item>
  );
}

export function MenuRadioItem({
  value,
  children,
  icon,
}: {
  value: string;
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <RadixMenu.RadioItem value={value} className={cn(ITEM, "pr-7")}>
      {icon && (
        <span className="flex size-4 items-center justify-center text-fg-secondary">
          {icon}
        </span>
      )}
      {children}
      <RadixMenu.ItemIndicator className="absolute right-2 flex items-center">
        <Check className="size-3.5 text-accent-text" aria-hidden />
      </RadixMenu.ItemIndicator>
    </RadixMenu.RadioItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <RadixMenu.Label className="px-2.5 pb-1 pt-1.5 text-caption font-semibold text-fg-secondary">
      {children}
    </RadixMenu.Label>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className="mx-1 my-1 h-px bg-hairline" />;
}
