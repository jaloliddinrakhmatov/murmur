import type { HubApi } from "../../shared/ipc.ts";

declare global {
  interface Window {
    hub: HubApi & { onNavigate(cb: (route: string) => void): () => void };
  }
}

export const hub = window.hub;
