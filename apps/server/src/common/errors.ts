import type { ErrorCode } from "@murmur/account-api";

const STATUS: Record<ErrorCode, number> = {
  "bad-request": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "rate-limited": 429,
  "code-invalid": 400,
  "code-expired": 400,
  "referral-own-code": 400,
  "referral-too-late": 409,
  "referral-already-applied": 409,
  "team-exists": 409,
  "team-last-owner": 409,
  "seats-full": 409,
  "promo-invalid": 400,
  "help-unavailable": 503,
  "server-error": 500,
};

/** An error the client may see: a stable code plus a message meant for people. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status ?? STATUS[code];
  }
}

export const apiError = (code: ErrorCode, message: string, status?: number) =>
  new ApiError(code, message, status);
