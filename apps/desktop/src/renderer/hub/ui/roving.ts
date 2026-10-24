// Arrow-key selection for single-choice groups (segmented controls, underline tabs, choice
// cards): the arrow moves the selection and the focus together, wrapping at the ends.
import type { KeyboardEvent, RefObject } from "react";

export function moveSelection<T>(
  e: KeyboardEvent,
  index: number,
  values: readonly T[],
  onChange: (v: T) => void,
  refs: RefObject<(HTMLElement | null)[]>,
): void {
  const d =
    e.key === "ArrowRight" || e.key === "ArrowDown"
      ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp"
        ? -1
        : 0;
  if (!d) return;
  e.preventDefault();
  const next = (index + d + values.length) % values.length;
  onChange(values[next]);
  refs.current?.[next]?.focus();
}
