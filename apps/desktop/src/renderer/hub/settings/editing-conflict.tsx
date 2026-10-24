import { useEffect, useState } from "react";
import { hub } from "../bridge.ts";
import { editingConflictNotice } from "../model/settings.ts";
import {
  editingConflict,
  type EditingConflict,
} from "../../../shared/shortcut-conflicts.ts";

/**
 * Whether a saved shortcut takes keys the focused app uses (Control-A, Command-B...). The answer
 * comes from the native validator, so the rule lives in one place. Shortcuts saved before the
 * rule existed keep working; this only lets the page warn.
 */
export function useEditingConflict(
  combo: string | null | undefined,
): EditingConflict | null {
  const [conflict, setConflict] = useState<EditingConflict | null>(null);
  useEffect(() => {
    setConflict(null);
    if (!combo) return;
    let current = true;
    hub
      .checkShortcut(combo, "pushToTalk")
      .then((check) => {
        if (current) setConflict(editingConflict(check.errors));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [combo]);
  return conflict;
}

/** A warning line for a saved shortcut that has an editing conflict; nothing otherwise. */
export function EditingConflictLine({
  combo,
  className = "mt-1.5 block text-warning",
}: {
  combo: string | null | undefined;
  className?: string;
}) {
  const conflict = useEditingConflict(combo);
  if (!combo || !conflict) return null;
  return (
    <span role="status" className={className}>
      {editingConflictNotice(conflict, combo)}
    </span>
  );
}
