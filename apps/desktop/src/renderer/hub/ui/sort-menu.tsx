// The reference's sort icon in a list toolbar: opens a menu of the orders the data supports.
import { useState } from "react";
import { ArrowUpDown } from "lucide-react";
import { IconButton } from "./button.tsx";
import {
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./menu.tsx";

export function SortMenu<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** What is sorted, e.g. "Sort words". */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const current = options.find((o) => o.id === value)?.label ?? "";
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton
          label={`${label}: ${current}`}
          icon={
            <ArrowUpDown className="size-[18px] stroke-[1.75]" aria-hidden />
          }
        />
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Sort</MenuLabel>
        <MenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <MenuRadioItem key={o.id} value={o.id}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * A list's chosen order, remembered for this window (a display preference, like the sidebar
 * state). Unknown stored values fall back to the default.
 */
export function useStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && allowed.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        // Storage unavailable: the choice lasts for this session only.
      }
    },
  ];
}
