// LEARN: three short practice cards. Each has a real text field; click into it, hold the shortcut
// and speak, and the main process delivers the text straight into the field. Speed estimates later
// come only from these practice dictations (words and how long the shortcut was held).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, cn, Kbd } from "../ui/index.ts";
import type { PracticeSample } from "../../../shared/onboarding.ts";
import { hub } from "../bridge.ts";
import { CenterScreen } from "./frame.tsx";
import { Card, useShortcutHeld } from "./setup.tsx";

export interface PracticeProps {
  /** Stable name for this field (the main process only needs to know one is focused). */
  field: string;
  appName: string;
  title: ReactNode;
  lead: string;
  /** What to say, shown in the card. */
  prompt: ReactNode;
  placeholder: string;
  combo: string;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onSample: (s: PracticeSample) => void;
  rows?: number;
  /** A line of the conversation or message header above the field. */
  context?: ReactNode;
}

export function PracticeStep(p: PracticeProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [dictated, setDictated] = useState(false);
  const { held, available } = useShortcutHeld(true);
  const field = useRef<HTMLTextAreaElement>(null);

  // Dictation arrives from the main process (it has already been transcribed and cleaned up);
  // it goes in where the cursor is, as typing would.
  const { onSample, field: fieldId } = p;
  useEffect(
    () =>
      hub.onPracticeText((e) => {
        if (e.fieldId !== fieldId || !e.text) return;
        const el = field.current;
        setText((prev) => {
          const start = el?.selectionStart ?? prev.length;
          const end = el?.selectionEnd ?? prev.length;
          const next = prev.slice(0, start) + e.text + prev.slice(end);
          requestAnimationFrame(() => {
            const at = start + e.text.length;
            field.current?.setSelectionRange(at, at);
          });
          return next;
        });
        setDictated(true);
        onSample({ words: e.words, seconds: e.durationMs / 1000 });
      }),
    [fieldId, onSample],
  );

  // The main process must stop delivering here when the card goes away.
  useEffect(
    () => () => void hub.setPracticeFocus(false, fieldId).catch(() => {}),
    [fieldId],
  );

  return (
    <CenterScreen
      title={p.title}
      lead={p.lead}
      onBack={p.onBack}
      onSkip={p.onSkip}
    >
      <Card wide className="overflow-hidden !p-0">
        <div className="border-b border-hairline bg-surface px-6 py-3 text-ui font-semibold text-fg">
          {p.appName}
        </div>
        <div className="space-y-4 px-6 py-5">
          {p.context}
          <div className="rounded-lg bg-accent-faint px-4 py-3 text-ui text-fg">
            {p.prompt}
          </div>
          <label htmlFor={id} className="sr-only">
            Practice field for {p.appName}
          </label>
          <textarea
            id={id}
            ref={field}
            rows={p.rows ?? 4}
            value={text}
            placeholder={p.placeholder}
            onChange={(e) => setText(e.target.value)}
            onFocus={() =>
              void hub.setPracticeFocus(true, p.field).catch(() => {})
            }
            onBlur={() =>
              void hub.setPracticeFocus(false, p.field).catch(() => {})
            }
            className={cn(
              "no-drag w-full resize-none rounded-md bg-modal px-3.5 py-3 text-body text-fg shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] placeholder:text-fg-tertiary",
              held && "shadow-[inset_0_0_0_2px_var(--m-accent)]",
            )}
          />
          <p className="flex flex-wrap items-center gap-x-2 text-caption text-fg-secondary">
            Click the field, then hold <Kbd combo={p.combo} active={held} />,
            speak, and let go.
            {!available
              ? " Live key feedback isn't available here, but dictation still works."
              : ""}
          </p>
        </div>
      </Card>
      <div
        className="mx-auto mt-6 flex max-w-[640px] justify-center"
        aria-live="polite"
      >
        {dictated && (
          <Button
            variant="primary"
            size="lg"
            className="min-w-48"
            onClick={p.onNext}
          >
            Continue
          </Button>
        )}
      </div>
    </CenterScreen>
  );
}

export const Emphasis = ({ children }: { children: ReactNode }) => (
  <em className="italic">{children}</em>
);

export function Bubble({
  mine,
  children,
}: {
  mine?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex", mine && "justify-end")}>
      <p
        className={cn(
          "max-w-[80%] rounded-xl px-3.5 py-2 text-ui",
          mine ? "bg-accent-soft text-fg" : "bg-surface text-fg",
        )}
      >
        {children}
      </p>
    </div>
  );
}
