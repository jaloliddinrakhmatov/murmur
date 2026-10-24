export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** The From header: `"Murmur" <you@gmail.com>` unless MURMUR_MAIL_FROM says otherwise. */
  from: string;
  /** True on port 465 (TLS from the first byte); otherwise STARTTLS is required. */
  secure: boolean;
}

export const SMTP_ENV_KEYS = [
  "MURMUR_SMTP_HOST",
  "MURMUR_SMTP_PORT",
  "MURMUR_SMTP_USER",
  "MURMUR_SMTP_PASS",
  "MURMUR_MAIL_FROM",
] as const;

/**
 * Reads the SMTP settings. Returns null when neither user nor password is set (SMTP not
 * configured); throws when the settings are half-set or can't be used safely. Plain-text SMTP
 * is never an option: port 465 is implicit TLS, every other port must upgrade with STARTTLS.
 */
export function parseSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const user = env.MURMUR_SMTP_USER?.trim() ?? "";
  const pass = env.MURMUR_SMTP_PASS?.replace(/\s+/g, "") ?? "";
  if (!user && !pass) return null;
  if (!user || !pass) {
    throw new Error("MURMUR_SMTP_USER and MURMUR_SMTP_PASS must both be set");
  }
  if (/[\r\n<>"]/.test(user) || !user.includes("@")) {
    throw new Error("MURMUR_SMTP_USER must be an email address");
  }
  const host = env.MURMUR_SMTP_HOST?.trim() || "smtp.gmail.com";
  const port = Number(env.MURMUR_SMTP_PORT?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MURMUR_SMTP_PORT must be a valid port number");
  }
  const from = env.MURMUR_MAIL_FROM?.trim() || `"Murmur" <${user}>`;
  if (/[\r\n]/.test(from)) {
    throw new Error("MURMUR_MAIL_FROM must be a single line");
  }
  return { host, port, user, pass, from, secure: port === 465 };
}
