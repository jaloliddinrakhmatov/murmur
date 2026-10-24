import { UserRound } from "lucide-react";
import type { Me } from "../../../shared/account.ts";
import { cn } from "../ui/index.ts";
import { initials } from "../model/account.ts";

/** The profile picture, or the initials on a quiet disc; a person icon while signed out. */
export function Avatar({
  me,
  size = "md",
  className,
}: {
  me: Pick<Me, "firstName" | "lastName" | "email" | "avatar"> | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const box = {
    sm: "size-7 text-caption",
    md: "size-8 text-caption",
    lg: "size-16 text-heading",
  }[size];
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full bg-surface-strong font-semibold text-fg",
        box,
        className,
      )}
    >
      {me?.avatar ? (
        <img src={me.avatar} alt="" className="size-full object-cover" />
      ) : me ? (
        initials(me)
      ) : (
        <UserRound className="size-4 text-fg-secondary" />
      )}
    </span>
  );
}
