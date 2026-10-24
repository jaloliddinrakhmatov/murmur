// "Set up Murmur": the sidebar checklist (reference: white card with a progress bar and round
// checkboxes). Steps come from live readiness (useStatus polls the main process and listens for
// changes), so the card disappears when setup is complete and comes back if a check fails.
// Once Murmur is set up, "Set up Notetaker" takes its place (reference 02) until Notetaker is set
// up and has a first meeting, or until its Today card is skipped.
import { useEffect, useState, type ReactNode } from "react";
import { Check, ListChecks, NotepadText } from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import { cn, Tooltip } from "../ui/index.ts";
import { useStatus } from "../pages/shared.tsx";
import { setupChecklist } from "../model/setup.ts";
import { notetakerChecklist } from "../model/notetaker.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";

export function SetupCard({
  collapsed,
  openSettings,
}: {
  collapsed: boolean;
  openSettings: (target: SettingsTarget) => void;
}) {
  const { status } = useStatus();
  if (!status) return null;
  const list = setupChecklist(status);
  if (list.complete) return null;
  return (
    <ChecklistCard
      kind="murmur"
      title="Set up Murmur"
      icon={<ListChecks className="size-[18px] stroke-[1.75]" aria-hidden />}
      collapsed={collapsed}
      done={list.done}
      onNext={() => list.next && openSettings(list.next)}
      steps={list.steps.map((s) => ({
        key: s.key,
        label: s.label,
        done: s.done,
        onSelect: () => openSettings(s.section),
      }))}
    />
  );
}

export function NotetakerSetupCard({
  collapsed,
  settings,
  navigate,
}: {
  collapsed: boolean;
  settings: Settings;
  navigate: (route: string) => void;
}) {
  const { status } = useStatus();
  const [count, setCount] = useState<number | null>(null);
  const wanted =
    !settings.notetaker.setupCardDismissed &&
    !(settings.notetaker.setupCompleted && (count ?? 0) > 0);
  useEffect(() => {
    if (!wanted) return;
    const load = () =>
      void hub
        .meetings({})
        .then((m) => setCount(m.length))
        .catch(() => setCount(null));
    load();
    return hub.onMeetingsChanged(load);
  }, [wanted]);
  if (!status || !setupChecklist(status).complete || count === null)
    return null;
  const list = notetakerChecklist(settings.notetaker, count);
  if (!list.visible) return null;
  const routes = { setup: "notetaker/setup", note: "notetaker/new" };
  const next = list.steps.find((s) => !s.done);
  return (
    <ChecklistCard
      kind="notetaker"
      title="Set up Notetaker"
      icon={<NotepadText className="size-[18px] stroke-[1.75]" aria-hidden />}
      collapsed={collapsed}
      done={list.done}
      onNext={() => next && navigate(routes[next.key])}
      steps={list.steps.map((s) => ({
        key: s.key,
        label: s.label,
        done: s.done,
        onSelect: () => navigate(s.done ? "notetaker" : routes[s.key]),
      }))}
    />
  );
}

function ChecklistCard({
  kind,
  title,
  icon,
  collapsed,
  done,
  onNext,
  steps,
}: {
  kind: string;
  title: string;
  icon: ReactNode;
  collapsed: boolean;
  done: number;
  onNext: () => void;
  steps: { key: string; label: string; done: boolean; onSelect: () => void }[];
}) {
  const summary = `${title}: ${done} of ${steps.length} done`;

  if (collapsed)
    return (
      <Tooltip content={summary} side="right">
        <button
          type="button"
          aria-label={summary}
          data-setup-card="collapsed"
          data-setup-kind={kind}
          onClick={onNext}
          className="no-drag flex h-9 w-full items-center justify-center rounded-md bg-modal text-fg hover:bg-surface-hover"
        >
          {icon}
        </button>
      </Tooltip>
    );

  return (
    <section
      aria-label={title}
      data-setup-card="expanded"
      data-setup-kind={kind}
      className="rounded-[10px] bg-modal px-4 pb-3 pt-4"
    >
      <button
        type="button"
        onClick={onNext}
        className="no-drag block w-full rounded-sm text-left text-caption font-semibold text-fg"
      >
        {title}
      </button>
      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={done}
        aria-valuetext={`${done} of ${steps.length} done`}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full rounded-full bg-success transition-[width] duration-[var(--m-duration-base)]"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>
      <ul className="mt-3 space-y-0.5">
        {steps.map((step) => (
          <li key={step.key}>
            <button
              type="button"
              onClick={step.onSelect}
              className="no-drag flex min-h-8 w-full items-center gap-2.5 rounded-sm py-1 text-left text-caption text-fg hover:text-fg-secondary"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-[18px] shrink-0 items-center justify-center rounded-full",
                  step.done
                    ? "bg-success-soft text-success"
                    : "shadow-[inset_0_0_0_1.5px_var(--m-fg-secondary)]",
                )}
              >
                {step.done && <Check className="size-3 stroke-[2.5]" />}
              </span>
              <span>
                {step.label}
                <span className="sr-only">
                  {step.done ? " (done)" : " (not done)"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
