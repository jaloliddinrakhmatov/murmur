/**
 * The website's client for the Murmur account server's public routes. Responses are validated with
 * the shared contract (@murmur/account-api); every failure becomes one of a few kinds, so no page
 * ever shows a raw error.
 */
import {
  PublicInviteResponse,
  PublicReferralResponse,
  ROUTES,
  WaitlistResponse,
} from "@murmur/account-api";

export type FailureKind =
  | "invalid-input"
  | "rate-limited"
  | "unreachable"
  | "not-configured"
  | "unexpected";

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; kind: FailureKind };

interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

/** Maps one HTTP answer to a result. */
export function interpretResponse<T>(
  status: number,
  body: unknown,
  schema: Schema<T>,
): ApiResult<T> {
  if (status === 429) return { ok: false, kind: "rate-limited" };
  if (status === 400 || status === 422) {
    return { ok: false, kind: "invalid-input" };
  }
  if (status >= 200 && status < 300) {
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, kind: "unexpected" };
  }
  return { ok: false, kind: "unexpected" };
}

const DEV_BASE = "http://127.0.0.1:4000/v1";

/** Set NEXT_PUBLIC_MURMUR_API at build time. Without it, only development talks to a local server. */
export function apiBase(
  env: string | undefined = process.env.NEXT_PUBLIC_MURMUR_API,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  const configured = env?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return nodeEnv === "production" ? null : DEV_BASE;
}

export const REQUEST_TIMEOUT_MS = 8000;

type Fetch = typeof fetch;

export async function requestJson<T>(
  method: "GET" | "POST",
  path: string,
  schema: Schema<T>,
  options: {
    body?: unknown;
    signal?: AbortSignal;
    fetchImpl?: Fetch;
    base?: string | null;
  } = {},
): Promise<ApiResult<T>> {
  const base = options.base === undefined ? apiBase() : options.base;
  if (!base) return { ok: false, kind: "not-configured" };
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const res = await (options.fetchImpl ?? fetch)(`${base}${path}`, {
      method,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
      headers:
        options.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return interpretResponse(res.status, body, schema);
  } catch {
    return { ok: false, kind: "unreachable" };
  }
}

export function fetchReferral(
  code: string,
  opts: { signal?: AbortSignal } = {},
) {
  return requestJson(
    "GET",
    ROUTES.publicReferral.path.replace(":code", encodeURIComponent(code)),
    PublicReferralResponse,
    opts,
  );
}

export function fetchInvite(
  token: string,
  opts: { signal?: AbortSignal } = {},
) {
  return requestJson(
    "GET",
    ROUTES.publicInvite.path.replace(":token", encodeURIComponent(token)),
    PublicInviteResponse,
    opts,
  );
}

export function joinWaitlist(email: string, source: string) {
  return requestJson("POST", ROUTES.waitlist.path, WaitlistResponse, {
    body: { email, source },
  });
}

/** Plain-language text for each failure. */
export function failureMessage(kind: FailureKind): string {
  switch (kind) {
    case "rate-limited":
      return "Too many tries from this network. Please wait a little while and try again.";
    case "invalid-input":
      return "The server didn't accept that. Check it and try again.";
    case "unreachable":
      return "Murmur's server didn't answer. Check your connection and try again in a moment.";
    case "not-configured":
      return "This site isn't connected to a server yet. Please try again later.";
    case "unexpected":
      return "Something went wrong on our side. Please try again in a moment.";
  }
}

const TOKEN_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

/** Invite codes are letters, digits and dashes; anything else can't be a code, so skip the request. */
export function isInviteTokenShape(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}
