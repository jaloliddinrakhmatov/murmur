/**
 * Search key shared by the renderer's in-memory filters and SQLite (registered as the
 * `murmur_fold` SQL function): NFC-normalized, lowercased with Unicode rules (unlike SQLite's
 * ASCII-only NOCASE) and whitespace-collapsed, so "CAFÉ", "café" and "café" all match.
 */
export function searchKey(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}
