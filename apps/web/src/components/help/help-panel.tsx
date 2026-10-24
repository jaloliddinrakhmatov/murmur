"use client";

import { HELP_LIMITS } from "@murmur/account-api";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  checkHelpStatus,
  helpFailureMessage,
  HELP_STORAGE_KEY,
  pageKind,
  parseStoredChat,
  serializeChat,
  streamHelp,
  type HelpFailureKind,
  type HelpStatus,
  type StoredHelpTurn,
} from "../../lib/help.ts";
import { useReducedMotion } from "../../motion/use-reduced-motion.ts";
import { MurmurMark } from "../logo.tsx";
import { HelpMarkdown } from "./help-markdown.tsx";
import "./help-panel.css";

const SUGGESTIONS = [
  "How do I set up Murmur?",
  "Dictation isn't pasting into my app",
  "Which transcription service should I use?",
  "Does Murmur work in Uzbek?",
] as const;

const HELP_LINKS = [
  { href: "/#faq", label: "Frequently asked questions" },
  { href: "/download", label: "Download and requirements" },
  { href: "/privacy", label: "Privacy" },
] as const;

const NEAR_LIMIT = Math.floor(HELP_LIMITS.maxUserChars * 0.8);
const MOBILE_QUERY = "(max-width: 639px)";

interface Live {
  id: number;
  text: string;
  /** The stream has ended; the text may still be drawing in. */
  final: boolean;
  failed?: HelpFailureKind;
  stopped?: boolean;
}

function useMobile(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(MOBILE_QUERY);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}

function restore(): StoredHelpTurn[] {
  try {
    const turns = parseStoredChat(sessionStorage.getItem(HELP_STORAGE_KEY));
    const last = turns[turns.length - 1];
    // The page was left mid-answer: offer to ask again.
    if (last && last.role === "user") {
      turns.push({ role: "assistant", content: "", failed: "interrupted" });
    }
    return turns;
  } catch {
    return [];
  }
}

function persist(turns: readonly StoredHelpTurn[]) {
  try {
    if (turns.length === 0) sessionStorage.removeItem(HELP_STORAGE_KEY);
    else sessionStorage.setItem(HELP_STORAGE_KEY, serializeChat(turns));
  } catch {
    // Private mode or storage full: the chat just won't survive a reload.
  }
}

/** Keeps the sheet inside the visible area when the phone keyboard opens. */
function useVisualViewport(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!active || !el || !vv) return;
    const apply = () => {
      el.style.setProperty("--help-vh", `${vv.height}px`);
      el.style.setProperty("--help-vt", `${vv.offsetTop}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      el.style.removeProperty("--help-vh");
      el.style.removeProperty("--help-vt");
    };
  }, [ref, active]);
}

/** While the sheet is modal: the page behind is inert and does not scroll. */
function useModalLock(
  panel: RefObject<HTMLElement | null>,
  launcher: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const root = panel.current?.closest("[data-help-root]");
    if (!active || !root) return;
    const changed: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === root || el.tagName === "SCRIPT" || el.hasAttribute("inert")) {
        continue;
      }
      el.setAttribute("inert", "");
      changed.push(el);
    }
    const button = launcher.current;
    button?.setAttribute("inert", "");
    const html = document.documentElement;
    const overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      for (const el of changed) el.removeAttribute("inert");
      button?.removeAttribute("inert");
      html.style.overflow = overflow;
    };
  }, [panel, launcher, active]);
}

function Waveform({ label }: { label: string }) {
  return (
    <span className="help-wave" role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} style={{ ["--i" as string]: i }} />
      ))}
    </span>
  );
}

function Avatar() {
  return (
    <span className="help-avatar" aria-hidden="true">
      <MurmurMark size={18} />
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const id = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(id);
  }, [state]);
  return (
    <button
      type="button"
      className="help-mini"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2.5" />
        <path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15" />
      </svg>
      <span aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Couldn't copy"
            : "Copy"}
      </span>
      <span className="sr-only"> answer</span>
    </button>
  );
}

function ErrorRow({
  kind,
  onRetry,
}: {
  kind: HelpFailureKind;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="help-error">
      <p>{helpFailureMessage(kind)}</p>
      {onRetry ? (
        <button
          type="button"
          className="help-mini help-mini-strong"
          onClick={onRetry}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />
          </svg>
          Retry
        </button>
      ) : null}
    </div>
  );
}

function AssistantBubble({
  children,
  tail,
  live = false,
}: {
  children?: React.ReactNode;
  tail?: React.ReactNode;
  live?: boolean;
}) {
  return (
    <div className="help-row help-row-a" data-live={live || undefined}>
      <Avatar />
      <div className="help-col">
        {children ? (
          <div className="help-bubble help-bubble-a">{children}</div>
        ) : null}
        {tail}
      </div>
    </div>
  );
}

/** The answer being written: text draws in a little behind what has arrived. */
function LiveAnswer({
  live,
  instant,
  onDrained,
}: {
  live: Live;
  instant: boolean;
  onDrained: () => void;
}) {
  const [count, setCount] = useState(0);
  const shown = instant ? live.text.length : Math.min(count, live.text.length);
  useEffect(() => {
    if (instant || shown >= live.text.length) return;
    const frame = requestAnimationFrame(() =>
      setCount(shown + Math.max(1, Math.ceil((live.text.length - shown) / 10))),
    );
    return () => cancelAnimationFrame(frame);
  }, [instant, shown, live.text.length]);
  const drained = live.final && shown >= live.text.length;
  useEffect(() => {
    if (drained) onDrained();
  }, [drained, onDrained]);

  return (
    <AssistantBubble live>
      {shown === 0 && !live.final ? (
        <Waveform label="Murmur is thinking" />
      ) : (
        <HelpMarkdown text={live.text.slice(0, shown)} />
      )}
    </AssistantBubble>
  );
}

export default function HelpPanel({
  open,
  panelId,
  launcherRef,
  onClose,
  onUnread,
}: {
  open: boolean;
  panelId: string;
  launcherRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onUnread: () => void;
}) {
  const pathname = usePathname();
  const mobile = useMobile();
  const reduced = useReducedMotion();
  const uid = useId();
  const panel = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const runs = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const liveRef = useRef<Live | null>(null);
  const mobileRef = useRef(false);

  const [turns, setTurns] = useState<StoredHelpTurn[]>(restore);
  const [live, setLiveState] = useState<Live | null>(null);
  const [status, setStatus] = useState<"checking" | HelpStatus>("checking");
  const [draft, setDraft] = useState("");

  const setLive = useCallback((next: Live | null) => {
    liveRef.current = next;
    setLiveState(next);
  }, []);

  mobileRef.current = mobile;
  useVisualViewport(panel, mobile && open);
  useModalLock(panel, launcherRef, mobile && open);

  useEffect(() => persist(turns), [turns]);

  const check = useCallback((force: boolean) => {
    setStatus("checking");
    checkHelpStatus({ force }).then(setStatus);
  }, []);
  useEffect(() => check(false), [check]);

  const busy = live !== null;
  const available = status !== "checking" && status.state === "available";

  // Focus: the composer when the panel opens (or when the check finishes while nothing has focus).
  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    if (available && composer.current) composer.current.focus();
    else if (!el.contains(document.activeElement)) el.focus();
  }, [open, available]);

  // Autosize the composer.
  useLayoutEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 136)}px`;
  }, [draft, available]);

  // Follow the answer while the visitor hasn't scrolled up.
  const shownLength = live?.text.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, shownLength, live?.id, status, open]);
  useEffect(() => {
    if (open) stick.current = true;
  }, [open]);

  const start = useCallback(
    async (history: StoredHelpTurn[]) => {
      controller.current?.abort();
      const id = ++runs.current;
      const ctl = new AbortController();
      controller.current = ctl;
      stick.current = true;
      let text = "";
      setLive({ id, text: "", final: false });
      const result = await streamHelp({
        messages: history,
        page: pageKind(pathname),
        signal: ctl.signal,
        onDelta: (piece) => {
          if (runs.current !== id) return;
          text += piece;
          setLive({ id, text, final: false });
        },
      });
      if (runs.current !== id) return;
      if (result.ok) {
        setLive({ id, text, final: true });
        return;
      }
      if (result.kind === "aborted") {
        setLive({ id, text, final: true, stopped: true });
        return;
      }
      if (result.kind === "unavailable") {
        setStatus({ state: "unavailable", reason: "unavailable" });
      }
      setLive({ id, text, final: true, failed: result.kind });
    },
    [pathname, setLive],
  );

  const drained = useCallback(() => {
    const done = liveRef.current;
    if (!done) return;
    setLive(null);
    if (done.stopped && !done.text) return;
    setTurns((list) => [
      ...list,
      { role: "assistant", content: done.text, failed: done.failed },
    ]);
    if (!openRef.current) onUnread();
    if (openRef.current && !mobileRef.current) composer.current?.focus();
  }, [onUnread, setLive]);

  function ask(text: string) {
    const content = text.trim();
    if (!content || busy || !available) return;
    if (content.length > HELP_LIMITS.maxUserChars) return;
    const next: StoredHelpTurn[] = [...turns, { role: "user", content }];
    setTurns(next);
    setDraft("");
    void start(next);
  }

  function retry() {
    const last = turns[turns.length - 1];
    if (busy || !last || last.role !== "assistant" || !last.failed) return;
    const rest = turns.slice(0, -1);
    setTurns(rest);
    void start(rest);
  }

  function stop() {
    controller.current?.abort();
  }

  function newChat() {
    runs.current++;
    controller.current?.abort();
    setLive(null);
    setTurns([]);
    setDraft("");
    composer.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !mobile) return;
    const nodes = Array.from(
      panel.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], textarea:not([disabled]), [tabindex="0"]',
      ) ?? [],
    ).filter((el) => el.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const empty = turns.length === 0 && !live;
  const unavailable = status !== "checking" && status.state === "unavailable";
  const hintId = `${uid}-hint`;
  const countId = `${uid}-count`;
  const closeOnNavigate = mobile ? onClose : undefined;

  return (
    <section
      ref={panel}
      id={panelId}
      role="dialog"
      aria-label="Murmur help"
      aria-modal={mobile ? true : undefined}
      tabIndex={-1}
      data-open={open}
      inert={!open}
      className="help-panel"
      onKeyDown={onKeyDown}
    >
      <header className="help-head">
        <Avatar />
        <h2 className="help-title">
          Murmur help <span className="help-badge">AI</span>
        </h2>
        <div className="help-head-actions">
          <button
            type="button"
            className="help-icon-btn"
            onClick={newChat}
            disabled={turns.length === 0 && !live}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>New chat</span>
          </button>
          <button
            type="button"
            className="help-icon-btn help-icon-only"
            onClick={onClose}
            aria-label="Close help"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </header>

      <div
        ref={scroller}
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        className="help-scroll"
        onScroll={(event) => {
          const el = event.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <AssistantBubble>
          <p>
            Hi, I&rsquo;m Murmur&rsquo;s helper. Ask me how Murmur works, or
            what to try when something doesn&rsquo;t.
          </p>
        </AssistantBubble>

        {empty && available ? (
          <ul className="help-chips" aria-label="Suggested questions">
            {SUGGESTIONS.map((q) => (
              <li key={q}>
                <button
                  type="button"
                  className="help-chip"
                  onClick={() => ask(q)}
                >
                  {q}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Messages"
          className="help-log"
        >
          {turns.map((turn, i) =>
            turn.role === "user" ? (
              <div key={i} className="help-row help-row-u">
                <div className="help-bubble help-bubble-u">
                  <span className="sr-only">You: </span>
                  {turn.content}
                </div>
              </div>
            ) : (
              <AssistantBubble
                key={i}
                tail={
                  turn.failed ? (
                    <ErrorRow
                      kind={turn.failed}
                      onRetry={
                        i === turns.length - 1 && !busy && !unavailable
                          ? retry
                          : undefined
                      }
                    />
                  ) : turn.content ? (
                    <div className="help-tail">
                      <CopyButton text={turn.content} />
                    </div>
                  ) : undefined
                }
              >
                {turn.content ? (
                  <>
                    <span className="sr-only">Murmur: </span>
                    <HelpMarkdown
                      text={turn.content}
                      onNavigate={closeOnNavigate}
                    />
                  </>
                ) : null}
              </AssistantBubble>
            ),
          )}
        </div>

        {live ? (
          <div aria-hidden="true">
            <LiveAnswer
              key={live.id}
              live={live}
              instant={reduced}
              onDrained={drained}
            />
          </div>
        ) : null}
        <p role="status" className="sr-only">
          {live && !live.final ? "Murmur is writing an answer." : ""}
        </p>

        {status === "checking" ? (
          <div className="help-checking">
            <Waveform label="Checking whether help is available" />
            <span>Checking&hellip;</span>
          </div>
        ) : null}
      </div>

      {unavailable ? (
        <div className="help-unavailable">
          <p className="help-unavailable-title">
            {status.reason === "unavailable" ||
            status.reason === "not-configured"
              ? "Help chat isn’t available right now."
              : helpFailureMessage(status.reason)}
          </p>
          <p className="help-muted">These pages may have your answer:</p>
          <ul>
            {HELP_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={closeOnNavigate}
                  className="help-link-row"
                >
                  {link.label}
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    aria-hidden="true"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="help-mini help-mini-strong"
            onClick={() => check(true)}
          >
            Check again
          </button>
        </div>
      ) : (
        <form
          className="help-composer"
          onSubmit={(event) => {
            event.preventDefault();
            ask(draft);
          }}
        >
          <label htmlFor={`${uid}-input`} className="sr-only">
            Your question
          </label>
          <span id={hintId} className="sr-only">
            Press Enter to send, Shift and Enter for a new line.
          </span>
          <div className="help-field">
            <textarea
              ref={composer}
              id={`${uid}-input`}
              rows={1}
              value={draft}
              maxLength={HELP_LIMITS.maxUserChars}
              placeholder="Ask a question…"
              disabled={status === "checking"}
              aria-describedby={
                draft.length >= NEAR_LIMIT ? `${hintId} ${countId}` : hintId
              }
              autoComplete="off"
              enterKeyHint="send"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  ask(draft);
                }
              }}
            />
            {live && !live.final ? (
              <button
                type="button"
                className="help-send help-stop"
                onClick={stop}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2.5" />
                </svg>
                <span className="sr-only">Stop answering</span>
              </button>
            ) : (
              <button
                type="submit"
                className="help-send"
                disabled={busy || status === "checking" || draft.trim() === ""}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                >
                  <path d="M12 19V6M6 11.5 12 5.5l6 6" />
                </svg>
                <span className="sr-only">Send message</span>
              </button>
            )}
          </div>
          {draft.length >= NEAR_LIMIT ? (
            <p
              id={countId}
              className="help-count"
              data-full={draft.length >= HELP_LIMITS.maxUserChars || undefined}
            >
              {draft.length.toLocaleString("en-US")} /{" "}
              {HELP_LIMITS.maxUserChars.toLocaleString("en-US")}
            </p>
          ) : null}
        </form>
      )}

      <p className="help-note">
        AI answers can be wrong. Don&rsquo;t share passwords or API keys.{" "}
        <Link href="/privacy#help-chat" onClick={closeOnNavigate}>
          Privacy
        </Link>
      </p>
    </section>
  );
}
