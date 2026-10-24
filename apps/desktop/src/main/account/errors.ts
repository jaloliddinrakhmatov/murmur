// Account errors in plain words. The server's `code` is stable; its `message` is only used where
// the code alone says too little. Nothing here reaches the network or touches tokens.
import { RULES, type ErrorCode } from "@murmur/account-api";

export type AccountErrorCode =
  | ErrorCode
  /** The server could not be reached (no network, refused, timed out). */
  | "offline"
  /** An action needs a signed-in account. */
  | "signed-out"
  /** The macOS Keychain can't keep a sign-in. */
  | "keychain"
  /** The server answered, but not in the shape the contract promises. */
  | "invalid-response"
  /** The configured server address isn't allowed. */
  | "server-url"
  /** The input was refused before anything was sent. */
  | "invalid-input";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  readonly status: number | null;
  constructor(
    code: AccountErrorCode,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.status = status;
  }
}

export const OFFLINE_MESSAGE = "Can't reach Murmur's server";

const FALLBACK_BY_STATUS = (status: number): ErrorCode =>
  status === 400 || status === 422
    ? "bad-request"
    : status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not-found"
          : status === 409
            ? "conflict"
            : status === 429
              ? "rate-limited"
              : "server-error";

/** The code to use when the body wasn't a valid ErrorBody. */
export const codeForStatus = FALLBACK_BY_STATUS;

/** A short server message is shown for the codes that depend on context. */
const useServerText = (m: string) => {
  const t = m.trim();
  return t.length > 0 && t.length <= 160 ? t : null;
};

export function friendlyMessage(code: ErrorCode, serverMessage = ""): string {
  switch (code) {
    case "bad-request":
      return (
        useServerText(serverMessage) ??
        "That isn't valid. Check it and try again."
      );
    case "unauthorized":
      return "Your session has ended. Sign in again.";
    case "forbidden":
      return "You don't have permission to do that.";
    case "not-found":
      return useServerText(serverMessage) ?? "That couldn't be found.";
    case "conflict":
      return (
        useServerText(serverMessage) ??
        "That conflicts with what is already saved."
      );
    case "rate-limited":
      return "Too many tries. Wait a few minutes, then try again.";
    case "code-invalid":
      return "That code isn't right. Check it and try again.";
    case "code-expired":
      return "That code has expired. Ask for a new one.";
    case "referral-own-code":
      return "That's your own code. Share it with a friend instead.";
    case "referral-too-late":
      return `A referral code can only be applied in the first ${RULES.referralApplyWindowDays} days of an account.`;
    case "referral-already-applied":
      return "You've already applied a referral code.";
    case "team-exists":
      return "You're already in a team. Leave it before creating or joining another.";
    case "team-last-owner":
      return "A team needs its owner, so the owner can't leave or be removed.";
    case "seats-full":
      return "Your team's plan has no free seat left. Ask the team owner to add seats, then try again.";
    case "promo-invalid":
      return "That promo code isn't valid.";
    case "help-unavailable":
      return "Help chat isn't available right now.";
    case "server-error":
      return "Murmur's server had a problem. Try again in a moment.";
  }
}
