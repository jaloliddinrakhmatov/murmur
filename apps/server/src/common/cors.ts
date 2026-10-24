import type { NextFunction, Request, Response } from "express";

/**
 * CORS for the website, on /v1/public/* only. The single allowed origin is the website's
 * (`webOrigin`); any other origin gets no CORS headers, so browsers block the response. Other
 * routes get none: the desktop app is not a browser and needs no CORS.
 */
export function publicCors(webOrigin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/v1/public/")) {
      next();
      return;
    }
    res.append("Vary", "Origin");
    if (req.headers.origin === webOrigin) {
      res.setHeader("Access-Control-Allow-Origin", webOrigin);
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
        res.setHeader("Access-Control-Max-Age", "600");
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}
