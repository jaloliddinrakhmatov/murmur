// The account snapshot, shared by every screen that shows it. The main process owns it (tokens,
// requests, caches); this module only mirrors what it pushes. Reading it never contacts the
// server: `refreshAccount` does, and the screens call it only while signed in.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { AccountStatus } from "../../../shared/account.ts";
import { hub } from "../bridge.ts";
import { ipcErrorMessage } from "../model/errors.ts";

let current: AccountStatus | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function set(next: AccountStatus) {
  current = next;
  for (const l of listeners) l();
}

function start(): () => void {
  let live = true;
  const off = hub.onAccountChanged((s) => live && set(s));
  void hub
    .accountStatus()
    .then((s) => live && !current && set(s))
    .catch(() => {});
  return () => {
    live = false;
    off();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** Asks the server for the profile, team, plan and referrals (signed-in only). */
export async function refreshAccount(): Promise<AccountStatus | null> {
  try {
    const s = await hub.accountRefresh();
    set(s);
    return s;
  } catch {
    return current;
  }
}

export function useAccount(): AccountStatus | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Refreshes once when a screen opens, if there is a session to refresh. */
export function useRefreshOnOpen(account: AccountStatus | null) {
  const signedIn = account?.phase === "signed-in";
  useEffect(() => {
    if (signedIn) void refreshAccount();
  }, [signedIn]);
}

/** Runs an action with a busy flag and a message from a failure. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(ipcErrorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

/** Seconds timer for a countdown; ticks once a second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
