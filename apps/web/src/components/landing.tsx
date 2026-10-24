"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ApiResult } from "../lib/api.ts";
import { Reveal } from "../motion/reveal.tsx";
import { SplitHeading } from "../motion/split-heading.tsx";

/** Runs one request when the page opens, and again on retry. Aborts on leave. */
export function useRemote<T>(
  run: ((signal: AbortSignal) => Promise<ApiResult<T>>) | null,
) {
  const [result, setResult] = useState<ApiResult<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!run) return;
    const ctl = new AbortController();
    setResult(null);
    run(ctl.signal).then((r) => {
      if (!ctl.signal.aborted) setResult(r);
    });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  return { result, retry: useCallback(() => setAttempt((n) => n + 1), []) };
}

export function Panel({
  eyebrow,
  title,
  children,
  busy = false,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  busy?: boolean;
}) {
  return (
    <section
      className="container-m py-20 sm:py-28"
      aria-busy={busy || undefined}
    >
      <div className="mx-auto max-w-2xl text-center">
        <Reveal eager>
          <p className="eyebrow">{eyebrow}</p>
        </Reveal>
        <SplitHeading
          as="h1"
          eager
          className="display mt-3 text-4xl sm:text-6xl"
        >
          {title}
        </SplitHeading>
        <Reveal eager delay={0.3}>
          {children}
        </Reveal>
      </div>
    </section>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <Panel eyebrow={label} title="One moment…" busy>
      <p role="status" className="mt-5 text-lg text-muted">
        {label}
      </p>
    </Panel>
  );
}

export function Problem({
  title,
  body,
  onRetry,
}: {
  title: ReactNode;
  body: string;
  onRetry?: () => void;
}) {
  return (
    <Panel eyebrow="Murmur" title={title}>
      <p role="status" className="mt-5 text-lg leading-relaxed text-muted">
        {body}
      </p>
      <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
        {onRetry && (
          <button type="button" onClick={onRetry} className="btn btn-primary">
            Try again
          </button>
        )}
        <Link href="/" className="btn btn-ghost">
          Go to the home page
        </Link>
      </div>
    </Panel>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
          setTimeout(() => setState("idle"), 2500);
        }}
      >
        {state === "copied" ? "Copied" : label}
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? "Copied to the clipboard" : ""}
        {state === "failed" ? "Couldn't copy" : ""}
      </span>
      {state === "failed" && (
        <span className="text-sm text-muted">
          Couldn&rsquo;t copy. Select it and copy by hand.
        </span>
      )}
    </>
  );
}

export function Steps({ steps }: { steps: { title: string; body: string }[] }) {
  return (
    <Reveal
      as="ol"
      stagger={0.1}
      className="mx-auto mt-12 grid max-w-3xl gap-5 text-left sm:grid-cols-3"
    >
      {steps.map((s, i) => (
        <li key={s.title} data-lift="" className="card p-6">
          <span className="font-serif text-3xl text-accent-text">{i + 1}</span>
          <h2 className="mt-2 font-semibold">{s.title}</h2>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">
            {s.body}
          </p>
        </li>
      ))}
    </Reveal>
  );
}
