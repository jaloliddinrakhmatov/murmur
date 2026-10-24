// Where the Murmur server may be: https anywhere, or plain http on this Mac. Packaged builds
// never allow anything else; development builds also allow plain http to another machine (a
// test server on the local network). Pure, so the settings schema, the main process and the
// tests share one rule.

export const DEFAULT_SERVER_URL = "http://127.0.0.1:4000";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export type ServerUrlCheck =
  { ok: true; url: string; loopback: boolean } | { ok: false; reason: string };

export function checkServerUrl(
  raw: string,
  options: { packaged: boolean },
): ServerUrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That isn't a web address." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, reason: "Use an https:// address." };
  if (u.username || u.password)
    return { ok: false, reason: "The address can't contain a login." };
  if (u.search || u.hash)
    return { ok: false, reason: "Use the server's base address only." };
  const loopback = LOOPBACK_HOSTS.includes(u.hostname);
  if (u.protocol === "http:" && !loopback && options.packaged)
    return {
      ok: false,
      reason: "Use https://, or an address on this Mac (127.0.0.1).",
    };
  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${u.origin}${path}`, loopback };
}
