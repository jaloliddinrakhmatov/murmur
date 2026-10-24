import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/** Peppered SHA-256 (HMAC) of a secret, scoped so a hash from one use can't match another. */
export function hashSecret(
  pepper: string,
  scope: string,
  value: string,
): string {
  return createHmac("sha256", pepper)
    .update(`${scope}\0${value}`)
    .digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function randomSignInCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function randomRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

// No 0/O/1/I/L: invite codes are read from an email and typed.
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randomInviteToken(length = 16): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += INVITE_ALPHABET[randomInt(0, INVITE_ALPHABET.length)];
  }
  return out;
}

/** Invite codes are shown as XXXX-XXXX-XXXX-XXXX; accept any case, spaces and dashes. */
export function normalizeInviteToken(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatInviteToken(token: string): string {
  return token.match(/.{1,4}/g)?.join("-") ?? token;
}

export function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function aesKey(secret: string, purpose: string): Buffer {
  return createHmac("sha256", secret).update(`key\0${purpose}`).digest();
}

/** AES-256-GCM with a key derived from `secret`; `aad` binds the ciphertext to its row. */
export function encryptSecret(
  secret: string,
  purpose: string,
  aad: string,
  plain: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(secret, purpose), iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Returns null when the value was tampered with or belongs to another row. */
export function decryptSecret(
  secret: string,
  purpose: string,
  aad: string,
  packed: string,
): string | null {
  try {
    const raw = Buffer.from(packed, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      aesKey(secret, purpose),
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([
      decipher.update(raw.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
