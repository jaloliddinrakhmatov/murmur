import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "../config/env.ts";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOST = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/;

/**
 * Whether a Host header is acceptable. Development: loopback names with the port the socket
 * really listens on (a rebinding page on another origin sends its own host name). Production:
 * exactly the configured public host.
 */
export function hostAllowed(
  header: string | undefined,
  localPort: number | undefined,
  config: Pick<AppConfig, "production" | "publicHost">,
): boolean {
  if (!header) return false;
  const value = header.toLowerCase();
  if (config.production) return value === config.publicHost;
  const m = HOST.exec(value);
  if (!m || !LOCAL_HOSTS.has(m[1])) return false;
  return Number(m[2] ?? 80) === localPort;
}

export function hostGuard(
  config: Pick<AppConfig, "production" | "publicHost">,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hostAllowed(req.headers.host, req.socket.localPort, config)) {
      next();
      return;
    }
    res.status(403).json({ code: "forbidden", message: "Unexpected host" });
  };
}
