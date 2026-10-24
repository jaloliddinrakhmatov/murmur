// The account's refresh token is a Keychain-encrypted secret, like the API keys: encrypted by the
// asynchronous safeStorage API, never plaintext, never replaced or deleted because the Keychain
// is unavailable or can't read it.
import type {
  KeychainSecrets,
  SecureStorage,
} from "../settings/secure-storage.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { TokenVault } from "./service.ts";

export const ACCOUNT_SECRET = "account:refresh";

// The token is kept with the server address that issued it. A value without one (saved by an
// earlier version) has origin null, which never matches, so it is not sent anywhere.
const encode = (token: string, origin: string) =>
  JSON.stringify({ v: 1, origin, token });

function decode(stored: string): { token: string; origin: string | null } {
  try {
    const parsed = JSON.parse(stored) as { origin?: unknown; token?: unknown };
    if (typeof parsed.token === "string")
      return {
        token: parsed.token,
        origin: typeof parsed.origin === "string" ? parsed.origin : null,
      };
  } catch {
    // not JSON: a bare token
  }
  return { token: stored, origin: null };
}

export function createTokenVault(
  secure: Pick<SecureStorage, "ready">,
  secrets: Pick<KeychainSecrets, "status" | "set">,
  settings: Pick<SettingsStore, "getSecret" | "setSecret">,
): TokenVault {
  return {
    available: () => secure.ready(),
    load: async () => {
      const state = secrets.status(ACCOUNT_SECRET);
      if (state === "absent") return { state };
      const stored =
        state === "ready" ? settings.getSecret(ACCOUNT_SECRET) : null;
      if (!stored)
        return { state: state === "unreadable" ? "unreadable" : "locked" };
      return { state: "ok", ...decode(stored) };
    },
    save: (token, origin) => secrets.set(ACCOUNT_SECRET, encode(token, origin)),
    clear: () => settings.setSecret(ACCOUNT_SECRET, ""),
  };
}
