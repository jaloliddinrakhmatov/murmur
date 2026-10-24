/**
 * Updates only the given KEY=value lines of a .env file's text, keeping every other line
 * (comments, order, unrelated settings). Existing keys are replaced in place; new ones are
 * appended. Values are written as is, so they must not contain newlines.
 */
export function mergeEnv(
  existing: string,
  updates: Record<string, string>,
): string {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Bad key: ${key}`);
    if (/[\r\n]/.test(value)) throw new Error(`${key} must be a single line`);
  }
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m && pending.has(m[1])) {
      const value = pending.get(m[1]) as string;
      pending.delete(m[1]);
      return `${m[1]}=${quote(value)}`;
    }
    return line;
  });
  for (const [key, value] of pending) out.push(`${key}=${quote(value)}`);
  return `${out.join("\n")}\n`;
}

/** Node's --env-file parser takes quoted values literally, so a "Name" <a@b> From survives. */
function quote(value: string): string {
  return /[\s"'#]/.test(value) ? `'${value.replace(/'/g, "")}'` : value;
}
