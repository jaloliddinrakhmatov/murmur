import { parseSmtpConfig } from "../mail/smtp.config.ts";
import type { SmtpConfig } from "../mail/smtp.config.ts";

export interface RateLimit {
  max: number;
  windowMs: number;
}

export const HELP_PROVIDERS = ["groq", "gemini", "openai", "fake"] as const;
export type HelpProviderKind = (typeof HELP_PROVIDERS)[number];

/** The website's AI help chat (MURMUR_HELP_*). Null in AppConfig = not configured. */
export interface HelpConfig {
  provider: HelpProviderKind;
  apiKey: string;
  /** Empty = the provider's default model. */
  model: string;
  /** Answers per day, all visitors together. */
  dailyLimit: number;
  /** Shown to visitors who need a person; null until the user sets one. */
  contact: string | null;
}

export interface AppConfig {
  databaseUrl: string;
  host: string;
  port: number;
  production: boolean;
  /** Keys the SHA-256 (HMAC) of sign-in codes, refresh tokens and invite tokens. */
  pepper: string;
  /** Signs access tokens. */
  tokenSecret: string;
  accessTtlSec: number;
  refreshTtlDays: number;
  /** Expose GET /v1/dev/outbox. Never in production. */
  devOutbox: boolean;
  publicUrl: string;
  /** The one origin allowed to call /v1/public/* from a browser (CORS): the website. */
  webOrigin: string;
  /** SMTP settings (MURMUR_SMTP_*), or null when email goes only to the dev outbox. */
  smtp: SmtpConfig | null;
  /** Website help chat; null when MURMUR_HELP_PROVIDER isn't set. */
  help: HelpConfig | null;
  /** The only Host header accepted in production (from MURMUR_PUBLIC_URL). */
  publicHost: string;
  /** Presenting a just-rotated refresh token within this window returns the same successor. */
  refreshGraceMs: number;
  limits: {
    startPerEmail: RateLimit;
    startPerIp: RateLimit;
    verifyPerIp: RateLimit;
    verifyPerEmail: RateLimit;
    joinPerUser: RateLimit;
    /** Invitation emails (team + referral) one user may trigger per day. */
    invitesPerDay: RateLimit;
    /** Persisted in Postgres (survive restarts), counted per normalized email over 24 hours. */
    startPerEmailDaily: RateLimit;
    verifyPerEmailDaily: RateLimit;
    /** Public website reads (plans) per IP. */
    publicRead: RateLimit;
    /** Public referral-code and invite lookups per IP: stops code enumeration. */
    publicLookup: RateLimit;
    /** Waitlist sign-ups per IP per day. */
    waitlistPerIpDaily: RateLimit;
    /** Help chat questions per IP: a short burst limit and a daily one. */
    helpPerIpShort: RateLimit;
    helpPerIpDaily: RateLimit;
  };
  /** After `after` attempts in the day, each next one must wait baseMs * 2^(n - after), up to maxMs. */
  backoff: {
    start: Backoff;
    verify: Backoff;
  };
}

export interface Backoff {
  after: number;
  baseMs: number;
  maxMs: number;
}

/** Referral reward rules that are the server's business (not shown to clients). */
export const REFERRAL_ANTI_FARMING = {
  /** The friend's words must be reported on at least this many distinct days... */
  minActiveDays: 3,
  /** ...and the friend's account must be at least this old. */
  minAccountAgeDays: 3,
  /** A referrer earns at most this many reward months in any rolling year. */
  maxRewardsPerYear: 12,
} as const;

const DEV_PEPPER = "dev-pepper-change-me";
const DEV_TOKEN_SECRET = "dev-token-secret-change-me";
const MIN = 60_000;
/** Where the local marketing website (apps/web) runs; the dev default for MURMUR_PUBLIC_URL. */
const DEV_WEB_URL = "http://localhost:3000";

export function defaultLimits(): AppConfig["limits"] {
  return {
    startPerEmail: { max: 5, windowMs: 15 * MIN },
    startPerIp: { max: 20, windowMs: 15 * MIN },
    verifyPerIp: { max: 30, windowMs: 15 * MIN },
    verifyPerEmail: { max: 25, windowMs: 15 * MIN },
    joinPerUser: { max: 10, windowMs: 15 * MIN },
    invitesPerDay: { max: 50, windowMs: 24 * 60 * MIN },
    startPerEmailDaily: { max: 10, windowMs: 24 * 60 * MIN },
    verifyPerEmailDaily: { max: 50, windowMs: 24 * 60 * MIN },
    publicRead: { max: 120, windowMs: MIN },
    publicLookup: { max: 30, windowMs: 15 * MIN },
    waitlistPerIpDaily: { max: 10, windowMs: 24 * 60 * MIN },
    helpPerIpShort: { max: 12, windowMs: 10 * MIN },
    helpPerIpDaily: { max: 60, windowMs: 24 * 60 * MIN },
  };
}

export function defaultBackoff(): AppConfig["backoff"] {
  return {
    start: { after: 3, baseMs: 30_000, maxMs: 60 * MIN },
    verify: { after: 10, baseMs: 5_000, maxMs: 15 * MIN },
  };
}

/**
 * Reads MURMUR_HELP_*. Unset provider = null (help chat off). The fake provider answers from the
 * knowledge base without any AI service, so it is for development and tests only. A typo or a
 * missing key is an error rather than a silently disabled chat.
 */
export function loadHelpConfig(
  env: NodeJS.ProcessEnv,
  production: boolean,
): HelpConfig | null {
  const provider = env.MURMUR_HELP_PROVIDER?.trim().toLowerCase();
  if (!provider) return null;
  if (!(HELP_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `MURMUR_HELP_PROVIDER must be one of ${HELP_PROVIDERS.filter((p) => p !== "fake").join(", ")}`,
    );
  }
  const kind = provider as HelpProviderKind;
  if (kind === "fake" && production) {
    throw new Error(
      "MURMUR_HELP_PROVIDER=fake is only allowed with MURMUR_ENV=development or test",
    );
  }
  const apiKey = env.MURMUR_HELP_API_KEY?.trim() ?? "";
  if (kind !== "fake" && !apiKey) {
    throw new Error(
      `MURMUR_HELP_API_KEY is required for the ${kind} help provider (run: npm run help:setup -w apps/server)`,
    );
  }
  if (/\s/.test(apiKey)) {
    throw new Error("MURMUR_HELP_API_KEY must not contain spaces or newlines");
  }
  const model = env.MURMUR_HELP_MODEL?.trim() ?? "";
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(model)) {
    throw new Error("MURMUR_HELP_MODEL isn't a valid model name");
  }
  const rawLimit = env.MURMUR_HELP_DAILY_LIMIT?.trim();
  const dailyLimit = rawLimit ? Number(rawLimit) : 500;
  if (
    !Number.isInteger(dailyLimit) ||
    dailyLimit < 1 ||
    dailyLimit > 1_000_000
  ) {
    throw new Error(
      "MURMUR_HELP_DAILY_LIMIT must be a whole number between 1 and 1000000",
    );
  }
  const contact = env.MURMUR_HELP_CONTACT?.trim() || null;
  if (contact && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contact)) {
    throw new Error("MURMUR_HELP_CONTACT must be an email address");
  }
  return { provider: kind, apiKey, model, dailyLimit, contact };
}

/**
 * Anything other than MURMUR_ENV=development or MURMUR_ENV=test is production: a missing or
 * misspelled value never enables dev secrets, the test payment provider or the dev outbox.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const development = env.MURMUR_ENV === "development";
  const test = env.MURMUR_ENV === "test";
  const production = !development && !test;
  const pepper = env.MURMUR_PEPPER ?? (production ? "" : DEV_PEPPER);
  const tokenSecret =
    env.MURMUR_TOKEN_SECRET ?? (production ? "" : DEV_TOKEN_SECRET);
  // Referral and invite links are {publicUrl}/r/CODE and {publicUrl}/join/TOKEN: pages of the
  // website. In development they lead to the local website; the production URL is required.
  const publicUrl = (
    env.MURMUR_PUBLIC_URL ??
    (production ? "https://murmur.example" : DEV_WEB_URL)
  ).replace(/\/+$/, "");
  if (production) {
    if (pepper.length < 32 || tokenSecret.length < 32) {
      throw new Error(
        "MURMUR_PEPPER and MURMUR_TOKEN_SECRET must be set to random strings of at least 32 characters (set MURMUR_ENV=development for local development)",
      );
    }
    if (pepper === tokenSecret) {
      throw new Error("MURMUR_PEPPER and MURMUR_TOKEN_SECRET must differ");
    }
    if (!env.DATABASE_URL)
      throw new Error("DATABASE_URL is required in production");
    if (!env.MURMUR_PUBLIC_URL || !publicUrl.startsWith("https://")) {
      throw new Error(
        "MURMUR_PUBLIC_URL (an https:// URL) is required in production",
      );
    }
  }
  let publicHost: string;
  try {
    publicHost = new URL(publicUrl).host.toLowerCase();
  } catch {
    throw new Error("MURMUR_PUBLIC_URL must be a valid URL");
  }
  const port = Number(env.PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid port number");
  }
  return {
    databaseUrl:
      env.DATABASE_URL ?? "postgresql://murmur@127.0.0.1:54329/murmur_dev",
    host: "127.0.0.1",
    port,
    production,
    pepper,
    tokenSecret,
    accessTtlSec: 15 * 60,
    refreshTtlDays: 60,
    devOutbox: !production && env.MURMUR_DEV_OUTBOX === "1",
    publicUrl,
    webOrigin: new URL(publicUrl).origin,
    smtp: parseSmtpConfig(env),
    help: loadHelpConfig(env, production),
    publicHost,
    refreshGraceMs: 60_000,
    limits: defaultLimits(),
    backoff: defaultBackoff(),
  };
}
