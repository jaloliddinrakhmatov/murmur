"use client";

import { useId, useRef, useState } from "react";
import { failureMessage, joinWaitlist } from "../lib/api.ts";
import { checkEmail, emailProblem } from "../lib/email.ts";
import { Icon } from "./icons.tsx";

type Status =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "done" }
  | { state: "error"; message: string; field: boolean };

/**
 * "Tell me when Murmur for Mac is ready". Posts to the account server's public waitlist route.
 * `tone="night"` is for dark bands such as the home page's final call to action.
 */
export function WaitlistForm({
  source,
  tone = "light",
  compact = false,
}: {
  source: string;
  tone?: "light" | "night";
  compact?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const night = tone === "night";
  const sending = status.state === "sending";
  const fieldError = status.state === "error" && status.field;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    const checked = checkEmail(value);
    if (!checked.ok) {
      setStatus({
        state: "error",
        message: emailProblem(checked.reason),
        field: true,
      });
      inputRef.current?.focus();
      return;
    }
    setStatus({ state: "sending" });
    const result = await joinWaitlist(checked.email, source);
    if (result.ok) {
      setStatus({ state: "done" });
      return;
    }
    setStatus({
      state: "error",
      message: failureMessage(result.kind),
      field: result.kind === "invalid-input",
    });
  }

  if (status.state === "done") {
    return (
      <div
        role="status"
        className={`flex items-center justify-center gap-3 rounded-2xl px-5 py-4 text-left ${
          night
            ? "bg-white/10 text-night-fg"
            : "bg-accent-faint text-fg ring-1 ring-hairline"
        }`}
      >
        <Icon
          name="check"
          className={night ? "text-[#ffa06b]" : "text-accent-text"}
        />
        <p>
          <strong className="font-semibold">You&rsquo;re on the list.</strong>{" "}
          <span className={night ? "text-night-muted" : "text-muted"}>
            We&rsquo;ll write once, when Murmur for Mac is ready.
          </span>
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className={compact ? "mx-auto w-full max-w-md" : "w-full max-w-md"}
    >
      <label
        htmlFor={`${id}-email`}
        className={
          compact ? "sr-only" : "mb-2 block text-left text-sm font-semibold"
        }
      >
        Email address
      </label>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          ref={inputRef}
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={value}
          maxLength={254}
          disabled={sending}
          aria-invalid={fieldError || undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            setValue(e.target.value);
            if (status.state === "error") setStatus({ state: "idle" });
          }}
          className={`min-h-11 w-full min-w-0 flex-1 rounded-full px-5 text-base outline-none transition-shadow placeholder:text-muted focus-visible:ring-2 focus-visible:ring-accent ${
            night
              ? "bg-white/10 text-night-fg ring-1 ring-night-line placeholder:text-night-muted"
              : "bg-modal text-fg ring-1 ring-hairline-strong"
          } ${fieldError ? "!ring-2 !ring-danger" : ""}`}
        />
        <button
          type="submit"
          disabled={sending}
          className={`btn disabled:opacity-70 ${
            night ? "bg-night-fg text-night hover:bg-white" : "btn-primary"
          }`}
        >
          {sending ? "Adding you…" : "Get notified"}
        </button>
      </div>
      <div
        id={`${id}-help`}
        aria-live="polite"
        className="mt-3 min-h-5 text-left text-sm"
      >
        {status.state === "error" ? (
          <p className={night ? "text-[#ffb08a]" : "text-danger"}>
            {status.message}
          </p>
        ) : (
          <p className={night ? "text-night-muted" : "text-muted"}>
            Only used to tell you when Murmur is ready. No newsletter.
          </p>
        )}
      </div>
    </form>
  );
}
