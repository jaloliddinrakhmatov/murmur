// SET UP: transcription service, a live microphone test, languages and a shortcut test. Each
// card changes the same settings as the Settings screens, through the same dialogs and groups.
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { MAX_LANGUAGES } from "../../../shared/languages.ts";
import type { Settings } from "../../../shared/settings.ts";
import type { StatusInfo } from "../../../shared/ipc.ts";
import { hub } from "../bridge.ts";
import { languageName, languagesFor } from "../model/languages.ts";
import { addLanguage, removeLanguage } from "../model/onboarding.ts";
import { litBars, meterHint } from "../model/microphone.ts";
import {
  Button,
  cn,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from "../ui/index.ts";
import {
  MicrophoneDialog,
  useMicPreview,
  useMicrophones,
} from "../settings/microphone-dialog.tsx";
import { ShortcutsDialog } from "../settings/shortcuts-dialog.tsx";
import { TranscriptionSection } from "../settings/services.tsx";
import type { Update } from "../settings/common.tsx";
import { CenterScreen } from "./frame.tsx";
import type { StepNav } from "./survey.tsx";

/** The card on a centred screen. */
export function Card({
  title,
  children,
  className,
  wide,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full rounded-card bg-modal p-7 shadow-popover",
        wide ? "max-w-[640px]" : "max-w-[520px]",
        className,
      )}
    >
      {title && (
        <h2 className="mb-5 text-lead font-semibold text-fg">{title}</h2>
      )}
      {children}
    </div>
  );
}

interface Common {
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
  refresh: () => void;
}

export function TranscriptionStep({
  settings,
  update,
  status,
  refresh,
  onBack,
  onNext,
}: StepNav & Common) {
  return (
    <CenterScreen
      title="Choose a transcription service"
      lead="Murmur sends each recording to it to get your text. Add its API key; you can change this later in Settings."
      onBack={onBack}
    >
      <Card wide className="space-y-5">
        <TranscriptionSection
          settings={settings}
          update={update}
          status={status}
          refresh={refresh}
        />
        <Button variant="primary" size="lg" className="w-full" onClick={onNext}>
          {status?.providerReady
            ? "Continue"
            : "Continue without a key for now"}
        </Button>
      </Card>
    </CenterScreen>
  );
}

const METER_COLUMNS = 13;

export function MicStep({ status, refresh, onBack, onNext }: StepNav & Common) {
  const mics = useMicrophones();
  const [dialog, setDialog] = useState(false);
  const { info } = mics;
  const granted =
    (status?.permissions.microphone ?? info?.permission) === "granted";
  const restartKey = info
    ? `${info.next}|${info.selected?.id ?? ""}|${info.devices.map((d) => d.id).join(",")}`
    : "";
  const preview = useMicPreview(
    granted && !dialog && Boolean(info?.devices.length),
    restartKey,
  );
  const lit = litBars(preview.meter.position, METER_COLUMNS);
  const hint =
    preview.state === "error"
      ? preview.error === "NotAllowedError"
        ? "Murmur isn't allowed to use the microphone."
        : preview.error === "NotReadableError"
          ? "Another app is using this microphone."
          : "Couldn't open this microphone."
      : preview.state === "recording"
        ? "A dictation is using the microphone right now."
        : meterHint(preview.meter, preview.meter.at);
  const live = preview.state === "live" || preview.state === "recording";
  return (
    <CenterScreen
      title="Test your microphone"
      lead="Built-in and wired microphones work best. Bluetooth headsets can be less reliable."
      onBack={onBack}
    >
      <Card title="Do you see bars moving while you speak?">
        {!granted ? (
          <div className="space-y-3">
            <p className="text-ui text-fg-secondary">
              Murmur can't hear the microphone yet. Allow it to run this test.
            </p>
            <Button
              variant="primary"
              onClick={() =>
                void (status?.permissions.microphone === "denied"
                  ? hub.openSystemSettings("microphone")
                  : hub.requestMicrophone().then(refresh))
              }
            >
              {status?.permissions.microphone === "denied"
                ? "Open System Settings"
                : "Allow microphone"}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg bg-surface p-5">
            <div
              role="meter"
              aria-label="Input level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(preview.meter.position * 100)}
              data-meter-lit={lit}
              className="flex h-14 items-center justify-between gap-2"
            >
              {Array.from({ length: METER_COLUMNS }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-full w-3 rounded-full transition-colors duration-100",
                    i < lit ? "bg-accent" : "bg-hairline-strong",
                  )}
                />
              ))}
            </div>
          </div>
        )}
        {granted && (
          <p
            aria-live="polite"
            className="mt-3 min-h-5 text-caption text-fg-secondary"
          >
            {hint ??
              (live
                ? info?.devices.length
                  ? "Say a few words."
                  : null
                : preview.state === "starting"
                  ? "Opening the microphone…"
                  : null)}
          </p>
        )}
        {granted && info && !info.devices.length && (
          <p className="mt-3 text-ui text-fg-secondary">
            No microphone found. Connect one, or check System Settings → Sound →
            Input.
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-3">
          <Button onClick={() => setDialog(true)}>Change microphone</Button>
          <Button variant="primary" onClick={onNext}>
            Yes
          </Button>
        </div>
      </Card>
      <MicrophoneDialog
        open={dialog}
        onOpenChange={setDialog}
        mics={mics}
        status={status}
        refresh={refresh}
      />
    </CenterScreen>
  );
}

export function LanguagesStep({
  settings,
  codes,
  setCodes,
  onBack,
  onNext,
}: StepNav & {
  settings: Settings;
  codes: string[];
  setCodes: (c: string[]) => void;
}) {
  const offered = languagesFor(settings.speech.provider);
  const rest = offered.filter((l) => !codes.includes(l.code));
  return (
    <CenterScreen
      title="Set the languages you speak"
      lead="Murmur tells the transcription service which languages to expect."
      onBack={onBack}
    >
      <Card>
        {codes.length === 0 && (
          <p className="mb-3 text-ui text-fg-secondary">
            No language chosen: Murmur will detect the language for you.
          </p>
        )}
        <ul aria-label="Your languages" className="flex flex-wrap gap-2.5">
          {codes.map((c) => (
            <li
              key={c}
              className="inline-flex min-h-11 items-center gap-1 rounded-md bg-accent-faint pl-4 pr-1.5 text-ui text-fg shadow-[inset_0_0_0_1.5px_var(--m-primary)]"
            >
              {languageName(c)}
              <button
                type="button"
                aria-label={`Remove ${languageName(c)}`}
                onClick={() => setCodes(removeLanguage(codes, c))}
                className="no-drag flex size-8 items-center justify-center rounded-sm text-fg-secondary hover:bg-surface-hover disabled:opacity-40"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
          {rest.length > 0 && codes.length < MAX_LANGUAGES && (
            <li>
              <Menu>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    aria-label="Add a language"
                    className="no-drag flex size-11 items-center justify-center rounded-md bg-sheet text-fg shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] hover:bg-surface"
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>
                </MenuTrigger>
                <MenuContent align="start" className="max-h-72 overflow-y-auto">
                  {rest.map((l) => (
                    <MenuItem
                      key={l.code}
                      onSelect={() => setCodes(addLanguage(codes, l.code))}
                    >
                      {l.name}
                      <span className="ml-auto text-caption text-fg-secondary">
                        {l.native}
                      </span>
                    </MenuItem>
                  ))}
                </MenuContent>
              </Menu>
            </li>
          )}
        </ul>
        <p className="mt-4 text-caption text-fg-secondary">
          You can change this any time in Settings → General. Only languages the
          selected transcription service accepts are offered.
        </p>
        <Button
          variant="primary"
          size="lg"
          className="mt-6 w-full"
          onClick={onNext}
        >
          Continue
        </Button>
      </Card>
    </CenterScreen>
  );
}

/** Shows the shortcut's keys lit while the person holds it (the main process reports presses). */
export function useShortcutHeld(active: boolean): {
  held: boolean;
  available: boolean;
} {
  const [held, setHeld] = useState(false);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    if (!active) return;
    const off = hub.onShortcutState((e) => setHeld(e.down));
    hub.watchShortcut(true).then(
      (ok) => setAvailable(ok),
      () => setAvailable(false),
    );
    return () => {
      off();
      setHeld(false);
      void hub.watchShortcut(false).catch(() => {});
    };
  }, [active]);
  return { held, available };
}

export function ShortcutStep({
  settings,
  update,
  status,
  onBack,
  onNext,
}: StepNav & Common) {
  const [dialog, setDialog] = useState(false);
  const [no, setNo] = useState(false);
  const { held, available } = useShortcutHeld(!dialog);
  const combo = status?.shortcut.combo || settings.shortcut;
  return (
    <CenterScreen
      title="Test your dictation shortcut"
      lead="Hold the keys, speak, and let go. Murmur never uses the fn key."
      onBack={onBack}
    >
      <Card title="Do the keys light up when you hold them?">
        <div
          className="flex items-center justify-center rounded-lg bg-surface py-9"
          aria-live="polite"
        >
          <Kbd combo={combo} size="lg" active={held} />
          <span className="sr-only">
            {held ? "Shortcut held" : "Shortcut not held"}
          </span>
        </div>
        {!available && (
          <p className="mt-3 text-caption text-fg-secondary">
            Live key feedback isn't available in this build. Hold the shortcut
            and watch the capsule at the bottom of your screen.
          </p>
        )}
        {no && (
          <p className="mt-3 text-ui text-fg-secondary" role="status">
            Try a different shortcut: another app may be using this one.
          </p>
        )}
        {status && !status.shortcut.registered && (
          <p role="alert" className="mt-3 text-ui text-danger">
            {status.shortcut.error ?? "This shortcut isn't registered."}
          </p>
        )}
        <div className="mt-5 flex items-center justify-between gap-3">
          <Button onClick={() => setDialog(true)}>Edit shortcut</Button>
          <div className="flex gap-3">
            <Button onClick={() => setNo(true)}>No</Button>
            <Button variant="primary" onClick={onNext}>
              Yes
            </Button>
          </div>
        </div>
      </Card>
      <ShortcutsDialog
        open={dialog}
        onOpenChange={setDialog}
        settings={settings}
        update={update}
        status={status}
      />
    </CenterScreen>
  );
}
