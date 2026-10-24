// Shortcuts that steal keys from the focused app. The rule lives in the native validator
// (murmur-core `shared_with_apps`); this only recognises its codes so main and the renderer agree.
export const EDITING_CONFLICT_CODES = [
  "control-letter-used-by-text-editing",
  "command-letter-used-by-apps",
] as const;

export type EditingConflict = (typeof EDITING_CONFLICT_CODES)[number];

/** The editing conflict named in a validator's error or warning codes, if any. */
export function editingConflict(
  codes: readonly string[],
): EditingConflict | null {
  return EDITING_CONFLICT_CODES.find((c) => codes.includes(c)) ?? null;
}
