// Code editors with an AI chat that Vibe coding (Settings → Vibe coding) works in. Matched by
// bundle id, case-insensitively.
export const VIBE_EDITOR_APPS =
  /^(com\.microsoft\.VSCode(Insiders)?$|com\.vscodium$|com\.todesktop\.230313mzl4w4u92$|com\.exafunction\.windsurf)/i;

export function isVibeEditor(bundleId: string | null | undefined): boolean {
  return VIBE_EDITOR_APPS.test(bundleId ?? "");
}

/** The editor's own folder under ~/Library/Application Support (where it keeps storage.json). */
export function editorSupportFolder(
  bundleId: string | null | undefined,
): string | null {
  const id = (bundleId ?? "").toLowerCase();
  if (id === "com.microsoft.vscode") return "Code";
  if (id === "com.microsoft.vscodeinsiders") return "Code - Insiders";
  if (id === "com.vscodium") return "VSCodium";
  if (id === "com.todesktop.230313mzl4w4u92") return "Cursor";
  if (id.startsWith("com.exafunction.windsurf")) return "Windsurf";
  return null;
}
