// Set up Notetaker (Stage 9D-1, updated for recording in 9D-2): what Notetaker does, which audio
// it records, the microphone, storage, the transcription and summary services, and consent. It
// only reads and explains: the one permission it can ask for is the microphone, and only when
// you press Allow. System audio is explained here and asked for by macOS the first time a
// recording uses it, never during setup; nothing is recorded. Finishing saves the choices.
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Check,
  Mic,
  MonitorSpeaker,
  ShieldCheck,
} from "lucide-react";
import type { NotetakerReadiness } from "../../../shared/meetings.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  Select,
  StatusDot,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  isRetentionDays,
  RETENTION_OPTIONS,
  SETUP_STEPS,
  type RetentionDays,
} from "../model/notetaker.ts";

const MIC_STATE: Record<
  NotetakerReadiness["microphone"],
  { label: string; tone: "success" | "warning" | "danger"; help: string }
> = {
  granted: {
    label: "Allowed",
    tone: "success",
    help: "Murmur can use your microphone (you allowed it for dictation).",
  },
  "not-determined": {
    label: "Not asked yet",
    tone: "warning",
    help: "macOS asks once when you press Allow.",
  },
  denied: {
    label: "Off",
    tone: "danger",
    help: "Turn Murmur on in System Settings → Privacy & Security → Microphone.",
  },
  restricted: {
    label: "Restricted",
    tone: "danger",
    help: "This Mac's settings don't allow microphone access.",
  },
  unknown: {
    label: "Unknown",
    tone: "warning",
    help: "macOS didn't report the microphone permission.",
  },
};

export function NotetakerSetupDialog({
  open,
  onOpenChange,
  settings,
  update,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  update: (p: unknown) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [ready, setReady] = useState<NotetakerReadiness | null>(null);
  const [readyError, setReadyError] = useState<string | null>(null);
  const [retention, setRetention] = useState<RetentionDays>(
    settings.notetaker.retentionDays,
  );
  const [consent, setConsent] = useState(
    settings.notetaker.consentAcknowledged,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    try {
      setReady(await hub.notetakerReadiness());
      setReadyError(null);
    } catch (e) {
      setReadyError(ipcErrorMessage(e));
    }
  };
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setRetention(settings.notetaker.retentionDays);
    setConsent(settings.notetaker.consentAcknowledged);
    setError(null);
    void check();
    // Fresh choices each time the dialog opens; later settings changes don't reset a visit.
  }, [open]);

  const current = SETUP_STEPS[step];
  const last = step === SETUP_STEPS.length - 1;
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await update({
        notetaker: {
          setupCompleted: true,
          consentAcknowledged: true,
          retentionDays: retention,
        },
      });
      onOpenChange(false);
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="md" data-notetaker-setup={current.id}>
        <DialogHeader
          title={current.title}
          description={`Set up Notetaker · Step ${step + 1} of ${SETUP_STEPS.length}`}
        />
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={SETUP_STEPS.length}
          aria-valuenow={step + 1}
          className="-mt-2 mb-5 flex gap-1"
        >
          {SETUP_STEPS.map((s, i) => (
            <span
              key={s.id}
              className={cn(
                "h-1 flex-1 rounded-full",
                i <= step ? "bg-fg" : "bg-surface-strong",
              )}
            />
          ))}
        </div>
        <div className="min-h-[220px] space-y-3 text-ui text-fg">
          {current.id === "about" && (
            <>
              <p>
                Notetaker keeps notes for your meetings on this Mac: a title,
                when it happened, and what you write.
              </p>
              <p>
                When you press Start, it records the meeting. When you stop, the
                recording is transcribed and then deleted; a summary is made
                only when you ask for one. It never starts recording on its own.
              </p>
            </>
          )}
          {current.id === "audio" && (
            <ul className="space-y-3">
              <AudioSource
                icon={<Mic className="size-4" aria-hidden />}
                title="Your microphone"
                text="Your side of the conversation. Murmur already has this permission if you dictate."
              />
              <AudioSource
                icon={<MonitorSpeaker className="size-4" aria-hidden />}
                title="Your Mac's sound (system audio)"
                text="Everything playing on your Mac, not only the meeting app: the other people in a call, but also music, videos and notifications. This needs a separate macOS permission (System Audio Recording). Murmur doesn't ask for it now: macOS asks the first time you record with it on. You can turn it off in Settings → Notetaker."
              />
              <li className="text-caption text-fg-secondary">
                Nothing is recorded during setup, and Notetaker never records in
                the background.
              </li>
            </ul>
          )}
          {current.id === "microphone" && (
            <MicrophoneStep ready={ready} error={readyError} recheck={check} />
          )}
          {current.id === "storage" && (
            <>
              <p>
                Meetings are stored in Murmur's database on this Mac. They
                aren't uploaded or synced, and they never appear in Murmur's
                logs.
              </p>
              <label
                htmlFor="setup-retention"
                className="block pt-2 font-medium"
              >
                Keep meetings for
              </label>
              <Select
                id="setup-retention"
                className="w-56"
                value={String(retention)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (isRetentionDays(n)) setRetention(n);
                }}
              >
                {RETENTION_OPTIONS.map((o) => (
                  <option key={o.days} value={o.days}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <p className="text-caption text-fg-secondary">
                Older meetings are deleted at launch and every 6 hours. You can
                change this in Settings → Notetaker.
              </p>
            </>
          )}
          {current.id === "services" && (
            <>
              <p>
                When you stop a recording, the audio is sent to the
                transcription service you chose for dictation. A summary is sent
                to the AI service only when you ask for one. Nothing is sent
                now.
              </p>
              {readyError ? (
                <DialogError message={readyError} />
              ) : (
                <dl className="space-y-3 rounded-card bg-surface px-4 py-3">
                  <ServiceRow
                    term="Transcription"
                    service={ready?.transcription.service}
                    issue={ready?.transcription.ready}
                  />
                  <ServiceRow
                    term="AI summary"
                    service={ready?.summary.service}
                    issue={ready?.summary.ready}
                  />
                </dl>
              )}
              <p className="text-caption text-fg-secondary">
                You can change either in Settings → Transcription and AI
                cleanup.
              </p>
            </>
          )}
          {current.id === "privacy" && (
            <>
              <ul className="space-y-2">
                {[
                  "Recording starts only when you press Start, and the menu bar shows it while it runs.",
                  "No hidden recording. Audio leaves this Mac only to be transcribed, and is deleted once the transcript is saved.",
                  "Deleting a meeting deletes it, and any audio it still has, from this Mac.",
                ].map((t) => (
                  <li key={t} className="flex gap-2">
                    <Check
                      className="mt-0.5 size-4 shrink-0 text-success"
                      aria-hidden
                    />
                    {t}
                  </li>
                ))}
              </ul>
              <div className="pt-2">
                <Checkbox
                  checked={consent}
                  onCheckedChange={setConsent}
                  label="I'll tell people before I record a meeting"
                  description="Recording laws differ by place; many require everyone's consent."
                />
              </div>
              <DialogError message={error} />
            </>
          )}
        </div>
        <DialogFooter>
          {step > 0 && (
            <Button
              variant="ghost"
              icon={<ArrowLeft className="size-3.5" aria-hidden />}
              onClick={() => setStep(step - 1)}
              disabled={busy}
              className="mr-auto"
            >
              Back
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {last ? (
            <Button
              variant="primary"
              disabled={!consent}
              loading={busy}
              onClick={() => void finish()}
            >
              Finish
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setStep(step + 1)}>
              Continue
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AudioSource({
  icon,
  title,
  text,
}: {
  icon: ReactNode;
  title: string;
  text: string;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-strong">
        {icon}
      </span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="block text-fg-secondary">{text}</span>
      </span>
    </li>
  );
}

function MicrophoneStep({
  ready,
  error,
  recheck,
}: {
  ready: NotetakerReadiness | null;
  error: string | null;
  recheck: () => Promise<void>;
}) {
  if (error) return <DialogError message={error} />;
  if (!ready) return <p className="text-fg-secondary">Checking…</p>;
  const s = MIC_STATE[ready.microphone];
  return (
    <>
      <p>
        Notetaker will record your microphone only while a recording you started
        is on.
      </p>
      <div className="flex flex-wrap items-center gap-3 rounded-card bg-surface px-4 py-3">
        <span className="flex items-center gap-2 font-medium">
          <ShieldCheck className="size-4" aria-hidden />
          Microphone access
        </span>
        <span role="status">
          <StatusDot tone={s.tone} label={s.label} />
        </span>
        <span className="ml-auto flex gap-2">
          {ready.microphone === "not-determined" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void hub.requestMicrophone().then(recheck)}
            >
              Allow microphone…
            </Button>
          )}
          {ready.microphone === "denied" && (
            <Button
              size="sm"
              onClick={() => void hub.openSystemSettings("microphone")}
            >
              Open System Settings
            </Button>
          )}
          {ready.microphone !== "granted" && (
            <Button size="sm" variant="ghost" onClick={() => void recheck()}>
              Check again
            </Button>
          )}
        </span>
      </div>
      <p className="text-caption text-fg-secondary">{s.help}</p>
    </>
  );
}

function ServiceRow({
  term,
  service,
  issue,
}: {
  term: string;
  service: string | undefined;
  /** null when ready; otherwise what's missing. */
  issue: string | null | undefined;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3">
      <dt className="w-28 shrink-0 text-fg-secondary">{term}</dt>
      <dd className="min-w-0 flex-1">
        {service === undefined ? (
          "Checking…"
        ) : (
          <>
            <span className="font-medium">{service}</span>{" "}
            <StatusDot
              tone={issue ? "warning" : "success"}
              label={issue ? "Not ready" : "Ready"}
              className="ml-1"
            />
            {issue && (
              <span className="block text-caption text-fg-secondary">
                {issue}
              </span>
            )}
          </>
        )}
      </dd>
    </div>
  );
}
