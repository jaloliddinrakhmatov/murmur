// Request checks for the local MCP server: the Host and Origin headers (against DNS rebinding and
// other web pages), the bearer token (constant-time) and the token format.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** "127.0.0.1:47821", "localhost" or "[::1]:47821"; anything else (or nothing) is refused. */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  try {
    return LOOPBACK_NAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/** No Origin (a native client) or a loopback one; a web page on another site is refused. */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    return LOOPBACK_NAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function bearerToken(authorization: string | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{1,256})$/.exec(authorization ?? "");
  return m ? m[1] : null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * The id of the client whose token this is. Every stored token is compared (digests of equal
 * length, constant time), so timing says nothing about which one was close.
 */
export function matchToken(
  presented: string,
  tokens: ReadonlyMap<string, string>,
): string | null {
  const given = digest(presented);
  let found: string | null = null;
  for (const [id, token] of tokens)
    if (timingSafeEqual(given, digest(token))) found = id;
  return found;
}

/** 32 random bytes; the prefix lets secret scanners recognise a leaked one. */
export function newToken(): string {
  return `mmr_${randomBytes(32).toString("base64url")}`;
}
