/**
 * Client for the website's help chat (POST /public/help/chat, a server-sent event stream) and its
 * status route. Pure logic: the SSE parser, the request builder and the failure mapping are unit
 * tested; nothing here touches React. Events are validated with the shared contract.
 */
import {
  ErrorBody,
  HELP_LIMITS,
  HelpChatEvent,
  HelpPageSchema,
  HelpStatusResponse,
  ROUTES,
} from "@murmur/account-api";
import { apiBase, requestJson } from "./api.ts";

export type HelpPage = ReturnType<typeof HelpPageSchema.parse>;
export type HelpRole = "user" | "assistant";
export interface HelpTurn {
  role: HelpRole;
  content: string;
}

/** Which kind of page this is. The path itself never leaves the browser (codes and tokens are in it). */
export function pageKind(pathname: string | null | undefined): HelpPage {
  const path = (pathname ?? "/").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (path === "/pricing") return "pricing";
  if (path === "/download") return "download";
  if (path === "/privacy") return "privacy";
  if (path === "/terms") return "terms";
  if (path === "/r" || path.startsWith("/r/")) return "referral";
  if (path === "/join" || path.startsWith("/join/")) return "join";
  return "other";
}

/**
 * The conversation as the server wants it: failed or empty answers removed, neighbours of the same
 * role merged, assistant text clipped to the limit, the newest HELP_LIMITS.maxMessages kept, and
 * starting with the visitor (a window that would begin with an answer drops it).
 */
export function buildRequestMessages(turns: readonly HelpTurn[]): HelpTurn[] {
  const merged: HelpTurn[] = [];
  for (const turn of turns) {
    const content = turn.content.trim();
    if (!content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      merged.push({ role: turn.role, content });
    }
  }
  for (const turn of merged) {
    const max =
      turn.role === "user"
        ? HELP_LIMITS.maxUserChars
        : HELP_LIMITS.maxAssistantChars;
    // A merged visitor message keeps its end: the newest words matter most.
    if (turn.content.length > max) {
      turn.content =
        turn.role === "user"
          ? turn.content.slice(-max)
          : turn.content.slice(0, max);
    }
  }
  let window = merged.slice(-HELP_LIMITS.maxMessages);
  while (window.length > 0 && window[0].role !== "user") {
    window = window.slice(1);
  }
  return window;
}

// ---- Server-sent events ----

export interface SseParser {
  /** Feeds decoded text; calls `onData` once per completed event with its joined data lines. */
  push(text: string): void;
  /** Call at the end of the stream: an event left without its blank line is still delivered. */
  end(): void;
}

/**
 * An incremental SSE parser. Handles chunks split anywhere (even between CR and LF), CRLF, CR and LF
 * line ends, comment lines (keep-alives), several events in one chunk, `data:` with or without a
 * space, multi-line data, and ignores other fields (event, id, retry).
 */
export function createSseParser(onData: (data: string) => void): SseParser {
  let buffer = "";
  let data: string[] = [];
  let started = false;

  function dispatch() {
    if (data.length > 0) {
      const joined = data.join("\n");
      data = [];
      onData(joined);
    }
  }

  function line(text: string) {
    if (text === "") return dispatch();
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== "data") return;
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    data.push(value);
  }

  function drain(final: boolean) {
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      if (c === "\r") {
        if (i + 1 >= buffer.length && !final) break; // might be the first half of CRLF
        line(buffer.slice(start, i));
        if (buffer[i + 1] === "\n") i++;
      } else {
        line(buffer.slice(start, i));
      }
      start = i + 1;
    }
    buffer = buffer.slice(start);
  }

  return {
    push(text) {
      if (!started) {
        started = true;
        if (text.startsWith("﻿")) text = text.slice(1);
      }
      buffer += text;
      drain(false);
    },
    end() {
      drain(true);
      if (buffer) line(buffer);
      buffer = "";
      dispatch();
    },
  };
}

// ---- Failures ----

export type HelpFailureKind =
  | "offline"
  | "unreachable"
  | "not-configured"
  | "rate-limited"
  | "unavailable"
  | "invalid"
  | "timeout"
  | "interrupted"
  | "server"
  | "aborted";

/** Plain-language text for each failure, in the same voice as the rest of the site. */
export function helpFailureMessage(kind: HelpFailureKind): string {
  switch (kind) {
    case "offline":
      return "You seem to be offline. Check your connection and try again.";
    case "unreachable":
      return "Murmur's server didn't answer. Check your connection and try again in a moment.";
    case "not-configured":
    case "unavailable":
      return "Help chat isn't available right now.";
    case "rate-limited":
      return "That's a lot of questions in a short time. Please wait a few minutes and try again.";
    case "invalid":
      return "That message couldn't be sent. Try shortening it or starting a new chat.";
    case "timeout":
      return "The answer is taking too long. Please try again.";
    case "interrupted":
      return "The answer was cut off. Please try again.";
    case "server":
      return "Something went wrong on our side. Please try again in a moment.";
    case "aborted":
      return "";
  }
}

export interface StreamLimits {
  /** Until the server starts answering. */
  connectMs: number;
  /** Silence allowed between pieces once streaming (keep-alives count). */
  idleMs: number;
  /** The whole answer. */
  totalMs: number;
}

export const STREAM_LIMITS: StreamLimits = {
  connectMs: 20_000,
  idleMs: 30_000,
  totalMs: 120_000,
};

export type StreamResult = { ok: true } | { ok: false; kind: HelpFailureKind };

export interface StreamOptions {
  messages: readonly HelpTurn[];
  page?: HelpPage;
  /** Stop button, closing, new chat. */
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  fetchImpl?: typeof fetch;
  base?: string | null;
  limits?: StreamLimits;
  isOnline?: () => boolean;
}

function statusKind(status: number, code: string | undefined): HelpFailureKind {
  if (status === 429 || code === "rate-limited") return "rate-limited";
  if (status === 503 || code === "help-unavailable") return "unavailable";
  if (status === 400 || status === 422) return "invalid";
  return "server";
}

function eventErrorKind(code: string): HelpFailureKind {
  if (code === "help-unavailable") return "unavailable";
  if (code === "rate-limited") return "rate-limited";
  return "server";
}

/** Sends the conversation and streams the answer's text pieces to `onDelta`. Never throws. */
export async function streamHelp(
  options: StreamOptions,
): Promise<StreamResult> {
  const base = options.base === undefined ? apiBase() : options.base;
  if (!base) return { ok: false, kind: "not-configured" };
  const online =
    options.isOnline ??
    (() => typeof navigator === "undefined" || navigator.onLine !== false);
  if (!online()) return { ok: false, kind: "offline" };

  const limits = options.limits ?? STREAM_LIMITS;
  const messages = buildRequestMessages(options.messages);
  if (messages.length === 0) return { ok: false, kind: "invalid" };

  const internal = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => internal.abort();
  if (options.signal?.aborted) return { ok: false, kind: "aborted" };
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timeout = (ms: number) =>
    setTimeout(() => {
      timedOut = true;
      internal.abort();
    }, ms);
  let timer = timeout(limits.connectMs);
  const total = setTimeout(() => {
    timedOut = true;
    internal.abort();
  }, limits.totalMs);

  const failure = (kind: HelpFailureKind): StreamResult => {
    if (options.signal?.aborted) return { ok: false, kind: "aborted" };
    if (timedOut) return { ok: false, kind: "timeout" };
    return { ok: false, kind };
  };

  try {
    let res: Response;
    try {
      res = await (options.fetchImpl ?? fetch)(
        `${base}${ROUTES.helpChat.path}`,
        {
          method: "POST",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: internal.signal,
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify({ messages, page: options.page }),
        },
      );
    } catch {
      return failure(online() ? "unreachable" : "offline");
    }

    if (!res.ok) {
      let code: string | undefined;
      try {
        const parsed = ErrorBody.safeParse(await res.json());
        if (parsed.success) code = parsed.data.code;
      } catch {
        code = undefined;
      }
      return failure(statusKind(res.status, code));
    }
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/event-stream") || !res.body) {
      return failure("server");
    }

    const state: { outcome: StreamResult | null } = { outcome: null };
    const parser = createSseParser((data) => {
      if (state.outcome) return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const event = HelpChatEvent.safeParse(json);
      if (!event.success) return;
      if (event.data.type === "delta") {
        if (event.data.text) options.onDelta(event.data.text);
      } else if (event.data.type === "done") {
        state.outcome = { ok: true };
      } else {
        state.outcome = { ok: false, kind: eventErrorKind(event.data.code) };
      }
    });

    const reader = res.body.getReader();
    // A stalled read must end the moment we abort, whatever the transport does with the signal.
    const aborted = new Promise<never>((_, reject) => {
      if (internal.signal.aborted) reject(new Error("aborted"));
      internal.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
    aborted.catch(() => undefined);
    const decoder = new TextDecoder();
    try {
      for (;;) {
        clearTimeout(timer);
        timer = timeout(limits.idleMs);
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
        if (state.outcome) break;
      }
      if (!state.outcome) {
        parser.push(decoder.decode());
        parser.end();
      }
    } catch {
      return failure(online() ? "interrupted" : "offline");
    } finally {
      reader.cancel().catch(() => undefined);
    }
    if (options.signal?.aborted) return { ok: false, kind: "aborted" };
    return state.outcome ?? { ok: false, kind: "interrupted" };
  } finally {
    clearTimeout(timer);
    clearTimeout(total);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}

// ---- Status ----

export type HelpStatus =
  { state: "available" } | { state: "unavailable"; reason: HelpFailureKind };

let cachedStatus: Promise<HelpStatus> | null = null;

/** Asks whether the helper is switched on. A definite answer is kept for the session. */
export function checkHelpStatus(
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<HelpStatus> {
  if (cachedStatus && !options.force) return cachedStatus;
  const pending = requestJson(
    "GET",
    ROUTES.helpStatus.path,
    HelpStatusResponse,
    { signal: options.signal },
  ).then((result): HelpStatus & { final: boolean } => {
    if (result.ok) {
      return result.data.available
        ? { state: "available", final: true }
        : { state: "unavailable", reason: "unavailable", final: true };
    }
    const reason: HelpFailureKind =
      result.kind === "not-configured"
        ? "not-configured"
        : result.kind === "rate-limited"
          ? "rate-limited"
          : "unreachable";
    return { state: "unavailable", reason, final: false };
  });
  const tracked = pending.then(({ final, ...status }) => {
    if (!final && cachedStatus === tracked) cachedStatus = null;
    return status as HelpStatus;
  });
  cachedStatus = tracked;
  return tracked;
}

/** For tests. */
export function resetHelpStatusCache() {
  cachedStatus = null;
}

// ---- Session storage ----

export const HELP_STORAGE_KEY = "murmur.help.v1";

export interface StoredHelpTurn {
  role: HelpRole;
  content: string;
  /** Set on an answer that failed; the visitor can retry it. */
  failed?: HelpFailureKind;
}

const FAILED_KINDS: readonly string[] = [
  "offline",
  "unreachable",
  "not-configured",
  "rate-limited",
  "unavailable",
  "invalid",
  "timeout",
  "interrupted",
  "server",
];

function storedTurn(value: unknown): StoredHelpTurn | null {
  if (typeof value !== "object" || value === null) return null;
  const { role, content, failed } = value as Record<string, unknown>;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof content !== "string") return null;
  if (content.length > HELP_LIMITS.maxAssistantChars) return null;
  if (failed === undefined) return { role, content };
  if (role !== "assistant" || typeof failed !== "string") return null;
  if (!FAILED_KINDS.includes(failed)) return null;
  return { role, content, failed: failed as HelpFailureKind };
}

/** Reads the saved conversation; anything malformed is ignored. */
export function parseStoredChat(raw: string | null): StoredHelpTurn[] {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list) || list.length > HELP_LIMITS.maxMessages * 2) {
      return [];
    }
    const turns = list.map(storedTurn);
    return turns.every((t) => t !== null) ? turns : [];
  } catch {
    return [];
  }
}

export function serializeChat(turns: readonly StoredHelpTurn[]): string {
  return JSON.stringify(turns.slice(-HELP_LIMITS.maxMessages * 2));
}
