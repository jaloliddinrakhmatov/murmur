import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "../../src/app.ts";
import { Clock } from "../../src/common/clock.ts";
import { defaultLimits, loadConfig } from "../../src/config/env.ts";
import type { AppConfig } from "../../src/config/env.ts";
import type { HelpModel } from "../../src/help/model.ts";
import type { Mailer } from "../../src/mail/mailer.ts";

export class FakeClock extends Clock {
  offsetMs = 0;
  override now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number) {
    this.offsetMs += ms;
  }
}

export const MINUTE = 60_000;
export const DAY = 86_400_000;

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export interface Session {
  email: string;
  accessToken: string;
  refreshToken: string;
  me: any;
}

export interface Harness {
  app: NestExpressApplication;
  clock: FakeClock;
  config: AppConfig;
  url: string;
  call(
    method: string,
    path: string,
    opts?: {
      token?: string;
      body?: unknown;
      raw?: string;
      headers?: Record<string, string>;
    },
  ): Promise<ApiResult>;
  /** Signs in through the real auth flow, reading the code from the dev outbox. */
  signIn(email?: string): Promise<Session>;
  code(email: string): Promise<string>;
  inviteToken(email: string): Promise<string>;
  close(): Promise<void>;
}

export const uniqueEmail = (prefix = "user") =>
  `${prefix}${randomBytes(4).toString("hex")}@example.com`;

export async function startApp(
  opts: {
    limits?: Partial<AppConfig["limits"]>;
    backoff?: Partial<AppConfig["backoff"]>;
    mailer?: Mailer;
    devOutbox?: boolean;
    /** Website help chat settings (default: not configured). */
    help?: AppConfig["help"];
    helpModel?: HelpModel | null;
  } = {},
): Promise<Harness> {
  const config = loadConfig({
    MURMUR_ENV: "test",
    DATABASE_URL:
      process.env.MURMUR_TEST_DATABASE_URL ??
      "postgresql://murmur@127.0.0.1:54329/murmur_test",
    MURMUR_DEV_OUTBOX: "1",
    MURMUR_PEPPER: "test-pepper",
    MURMUR_TOKEN_SECRET: "test-token-secret",
  });
  config.devOutbox = opts.devOutbox ?? true;
  config.help = opts.help ?? null;
  // Roomy limits so tests sharing one IP don't trip them; rate-limit tests pass their own.
  config.limits = {
    ...defaultLimits(),
    startPerIp: { max: 100_000, windowMs: 15 * MINUTE },
    verifyPerIp: { max: 100_000, windowMs: 15 * MINUTE },
    ...opts.limits,
  };
  config.backoff = { ...config.backoff, ...opts.backoff };
  const clock = new FakeClock();
  const app = await createApp({
    config,
    clock,
    mailer: opts.mailer,
    helpModel: opts.helpModel,
    quiet: true,
  });
  await app.listen(0, "127.0.0.1");
  const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  const call: Harness["call"] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.body !== undefined || o.raw !== undefined)
      headers["content-type"] = "application/json";
    const res = await fetch(`${url}/v1${path}`, {
      method,
      headers,
      body:
        o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  };

  const outbox = async (email: string, kind: string) => {
    const r = await call(
      "GET",
      `/dev/outbox?to=${encodeURIComponent(email)}&limit=50`,
    );
    const row = r.body.emails.find((e: any) => e.kind === kind);
    if (!row) throw new Error(`no ${kind} email for ${email}`);
    return row.code as string;
  };

  return {
    app,
    clock,
    config,
    url,
    call,
    code: (email) => outbox(email, "sign-in-code"),
    inviteToken: (email) => outbox(email, "team-invite"),
    async signIn(email = uniqueEmail()) {
      const start = await call("POST", "/auth/start", { body: { email } });
      if (start.status !== 200)
        throw new Error(`start failed: ${JSON.stringify(start.body)}`);
      const code = await outbox(email, "sign-in-code");
      const verify = await call("POST", "/auth/verify", {
        body: {
          email,
          code,
          device: { name: "Test Mac", platform: "macos", appVersion: "0.0.0" },
        },
      });
      if (verify.status !== 200)
        throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
      return {
        email,
        accessToken: verify.body.tokens.accessToken,
        refreshToken: verify.body.tokens.refreshToken,
        me: verify.body.me,
      };
    },
    async close() {
      await app.close();
    },
  };
}

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
export const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 2),
]);
export const dataUrl = (mime: string, bytes: Buffer) =>
  `data:${mime};base64,${bytes.toString("base64")}`;

const dayString = (clock: FakeClock, back: number) =>
  new Date(clock.now().getTime() - back * DAY).toISOString().slice(0, 10);

/**
 * Makes a friend meet the referral reward rules: the account becomes 3 days old (the fake clock
 * moves, so everybody signs in again) and 2,100 words are reported on three different days.
 * Returns the friend's new session.
 */
export async function qualifyFriend(
  h: Harness,
  friend: Session,
  words = [700, 700, 700],
): Promise<Session> {
  h.clock.advance(3 * DAY + MINUTE);
  const s = await h.signIn(friend.email);
  for (const [i, w] of words.entries()) {
    const r = await h.call("POST", "/usage", {
      token: s.accessToken,
      body: { day: dayString(h.clock, i), words: w },
    });
    if (r.status !== 200)
      throw new Error(`usage failed: ${JSON.stringify(r.body)}`);
  }
  return s;
}
