"use client";

import dynamic from "next/dynamic";
import { useCallback, useId, useRef, useState } from "react";
import "./help.css";

// The chat itself loads when the visitor reaches for the button, not with the page.
const loadPanel = () => import("./help-panel.tsx");
const HelpPanel = dynamic(loadPanel, { ssr: false });

/** The floating "Ask Murmur" button on every page, and the lazily loaded chat panel it opens. */
export function HelpWidget() {
  const panelId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [unread, setUnread] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    launcher.current?.focus();
  }, []);
  const markUnread = useCallback(() => setUnread(true), []);

  return (
    <div data-help-root className="help-root">
      <button
        ref={launcher}
        type="button"
        className="help-launcher"
        aria-expanded={open}
        aria-controls={mounted ? panelId : undefined}
        aria-label={
          open
            ? "Close Murmur help"
            : unread
              ? "Ask Murmur (new answer)"
              : "Ask Murmur"
        }
        data-open={open}
        onPointerEnter={() => void loadPanel()}
        onFocus={() => void loadPanel()}
        onTouchStart={() => void loadPanel()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) close();
        }}
        onClick={() => {
          if (open) return close();
          setMounted(true);
          setOpen(true);
          setUnread(false);
        }}
      >
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
          <g className="help-ic-pill">
            <path d="M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7Z" />
            <circle className="help-ic-dot" cx="16" cy="12" r="2.1" />
          </g>
          <g className="help-ic-x">
            <path d="M7 7l10 10M17 7 7 17" />
          </g>
        </svg>
        {unread ? <span className="help-unread" aria-hidden="true" /> : null}
        <span className="help-tip" aria-hidden="true">
          Ask Murmur
        </span>
      </button>
      {mounted ? (
        <HelpPanel
          open={open}
          panelId={panelId}
          launcherRef={launcher}
          onClose={close}
          onUnread={markUnread}
        />
      ) : null}
    </div>
  );
}
