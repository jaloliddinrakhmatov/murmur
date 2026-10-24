import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { StatusInfo } from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";

// One status source for every page: a single poll (and one statusChanged listener) however many
// components read it, paused while the window is hidden.
let currentStatus: StatusInfo | null = null;
const statusListeners = new Set<() => void>();
let stopStatus: (() => void) | null = null;

function refreshStatus() {
  hub
    .getStatus()
    .then((s) => {
      currentStatus = s;
      statusListeners.forEach((l) => l());
    })
    // The next poll or change event tries again; the last known status stays on screen.
    .catch(() => {});
}

function startStatus() {
  const refreshIfVisible = () => {
    if (document.visibilityState === "visible") refreshStatus();
  };
  refreshIfVisible();
  const off = hub.onStatusChanged(refreshStatus);
  const timer = setInterval(refreshIfVisible, 2000);
  document.addEventListener("visibilitychange", refreshIfVisible);
  return () => {
    off();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", refreshIfVisible);
  };
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener);
  stopStatus ??= startStatus();
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size === 0) {
      stopStatus?.();
      stopStatus = null;
    }
  };
}

export function useStatus() {
  const status = useSyncExternalStore(subscribeStatus, () => currentStatus);
  return { status, refresh: refreshStatus };
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const reload = useCallback(
    async () => setSettings(await hub.getSettings()),
    [],
  );
  useEffect(() => void reload(), [reload]);
  const update = useCallback(
    async (patch: unknown) => setSettings(await hub.updateSettings(patch)),
    [],
  );
  return { settings, update, reload };
}
