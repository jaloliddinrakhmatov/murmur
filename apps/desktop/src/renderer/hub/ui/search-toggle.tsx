// Reference toolbars show search as an icon that opens into a field. Collapsed: an icon button
// with the field's name. Open: the search field, focused. It closes again when it loses focus
// while empty, or on Esc when empty (focus returns to the icon). Callers focus it through the
// ref, which opens it first.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Search } from "lucide-react";
import { IconButton } from "./button.tsx";
import { SearchInput } from "./form.tsx";
import { cn } from "./cn.ts";

export interface SearchToggleHandle {
  focus(): void;
}

export const SearchToggle = forwardRef<
  SearchToggleHandle,
  {
    value: string;
    onValueChange: (v: string) => void;
    /** Accessible name of both the button and the field. */
    label: string;
    placeholder?: string;
    className?: string;
  }
>(function SearchToggle(
  { value, onValueChange, label, placeholder, className },
  ref,
) {
  const [open, setOpen] = useState(value !== "");
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wantFocus = useRef(false);
  useImperativeHandle(ref, () => ({
    focus() {
      wantFocus.current = true;
      if (open) input.current?.focus();
      else setOpen(true);
    },
  }));
  useEffect(() => {
    if (open && wantFocus.current) {
      wantFocus.current = false;
      input.current?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (value) setOpen(true);
  }, [value]);

  if (!open)
    return (
      <IconButton
        ref={button}
        label={label}
        icon={<Search className="size-[18px] stroke-[1.75]" aria-hidden />}
        onClick={() => {
          wantFocus.current = true;
          setOpen(true);
        }}
      />
    );
  return (
    <div
      className={cn("w-60", className)}
      onBlur={(e) => {
        if (!value && !e.currentTarget.contains(e.relatedTarget as Node))
          setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !value) {
          e.stopPropagation();
          setOpen(false);
          setTimeout(() => button.current?.focus());
        }
      }}
    >
      <SearchInput
        ref={input}
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
  );
});
