// PERMISSIONS: what Murmur may do on this Mac. Every Allow button is the click that asks macOS;
// nothing is requested when a screen opens.
import { useEffect, useState, type ReactNode } from "react";
import { AudioLines, Calendar, Keyboard, Mic } from "lucide-react";
import type { CalendarStatus } from "../../../shared/calendar.ts";
import type { AppInfo, StatusInfo } from "../../../shared/ipc.ts";
import type { SystemAudioStatus } from "../../../shared/onboarding.ts";
import { hub } from "../bridge.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { MICROPHONE_STATE } from "../model/settings.ts";
import { calendarRowView, connectAsksMacOS } from "../model/connectors.ts";
import { Button, cn } from "../ui/index.ts";
import { CalendarPreview, DoneMark, PromptPreview } from "./art.tsx";
import { ContinueButton, SplitScreen } from "./frame.tsx";
import type { StepNav } from "./survey.tsx";

type Which = "microphone" | "sound" | "accessibility";

const PROMPT_TEXT: Record<Which, string> = {
  microphone: "access the microphone",
  sound: "record your Mac's sound",
  accessibility: "control this computer using accessibility features",
};

function PermissionCard({
  icon,
  title,
  description,
  badge,
  control,
  onActive,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  badge?: string;
  control: ReactNode;
  onActive: () => void;
}) {
  return (
    <li
      onMouseEnter={onActive}
      onFocusCapture={onActive}
      className="flex items-start gap-4 rounded-card bg-surface p-5"
    >
      <span aria-hidden className="mt-0.5 text-fg-secondary">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ui font-semibold text-fg">
          {title}
          {badge && (
            <span className="ml-2 text-caption font-normal text-fg-secondary">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-1 text-ui text-fg-secondary">{description}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">{control}</div>
    </li>
  );
}

function Granted() {
  return (
    <span className="inline-flex items-center gap-2 text-ui text-success">
      <DoneMark />
      Allowed
    </span>
  );
}

export function PermissionsStep({
  status,
  refresh,
  about,
  notetaker,
  onBack,
  onNext,
}: StepNav & {
  status: StatusInfo | null;
  refresh: () => void;
  about: AppInfo | null;
  notetaker: boolean;
}) {
  const [active, setActive] = useState<Which>("microphone");
  const [sound, setSound] = useState<SystemAudioStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mic = status?.permissions.microphone;
  const micState = mic ? MICROPHONE_STATE[mic] : null;
  const accessibility = status?.permissions.accessibility ?? false;

  // Settings can change behind our back while System Settings is open.
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
    refresh();
  };
  // Reading the status asks macOS for nothing; only Allow can show its prompt.
  useEffect(() => {
    if (!notetaker) return;
    let live = true;
    hub.systemAudioStatus().then(
      (s) => live && setSound(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [notetaker]);
  const askSound = async () => {
    setAsking(true);
    setError(null);
    try {
      setSound(await hub.requestSystemAudio());
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setAsking(false);
    }
  };
  const soundUnsupported = sound !== null && sound.support !== "available";

  return (
    <SplitScreen
      title="Allow Murmur to…"
      lead="macOS asks you once for each. Murmur only listens while you hold your shortcut."
      onBack={onBack}
      art={<PromptPreview what={PROMPT_TEXT[active]} />}
      footer={<ContinueButton onClick={onNext} />}
    >
      <ul className="space-y-3">
        <PermissionCard
          icon={<Mic className="size-5" />}
          title="Hear you speak"
          description={
            mic === "denied" || mic === "restricted"
              ? `${micState?.help}${mic === "denied" && about && !about.packaged ? " In development builds, macOS lists Murmur as “Electron”." : ""}`
              : "Murmur uses the microphone to turn your voice into text."
          }
          onActive={() => setActive("microphone")}
          control={
            mic === "granted" ? (
              <Granted />
            ) : mic === "denied" ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void hub.openSystemSettings("microphone")}
              >
                Open System Settings
              </Button>
            ) : mic === "restricted" ? (
              <span className="text-ui text-danger">Restricted</span>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!status}
                onClick={() => void run(() => hub.requestMicrophone())}
              >
                Allow
              </Button>
            )
          }
        />
        {notetaker && (
          <PermissionCard
            icon={<AudioLines className="size-5" />}
            title="Hear your Mac's sound"
            description={
              sound?.access === "denied" || soundUnsupported
                ? (sound?.message ?? "Your Mac's sound can't be recorded here.")
                : "For Notetaker: the other people in a call. Murmur records it only after you press Start."
            }
            onActive={() => setActive("sound")}
            control={
              sound?.access === "allowed" ? (
                <Granted />
              ) : soundUnsupported ? (
                <span className="text-caption text-fg-secondary">
                  Not available
                </span>
              ) : (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={asking}
                    disabled={!sound}
                    onClick={() => void askSound()}
                  >
                    Allow
                  </Button>
                  {sound?.access === "denied" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void hub.openSystemSettings("sound")}
                    >
                      Sound Settings
                    </Button>
                  )}
                </>
              )
            }
          />
        )}
        <PermissionCard
          icon={<Keyboard className="size-5" />}
          title="Paste for you"
          badge="Optional"
          description={
            accessibility
              ? "Accessibility is on, so Murmur pastes where your cursor is."
              : "Accessibility lets Murmur paste automatically. Without it, each result is copied and you paste with ⌘V."
          }
          onActive={() => setActive("accessibility")}
          control={
            accessibility ? (
              <Granted />
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void run(() => hub.requestAccessibility())}
                >
                  Allow
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void hub.openSystemSettings("accessibility")}
                >
                  System Settings
                </Button>
              </>
            )
          }
        />
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-caption text-danger">
          {error}
        </p>
      )}
    </SplitScreen>
  );
}

export function CalendarStep({ onBack, onNext }: StepNav) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    hub.calendarStatus().then(
      (s) => live && setStatus(s),
      (e) => live && setError(ipcErrorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const view = status ? calendarRowView(status) : null;
  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await hub.connectCalendar());
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const connected = view?.action === "disconnect";
  return (
    <SplitScreen
      title="Connect your calendar"
      lead="Murmur can list your upcoming meetings so you can start notes with one click. Events stay on this Mac."
      onBack={onBack}
      art={<CalendarPreview />}
      footer={
        <ContinueButton onClick={onNext}>
          {connected ? "Continue" : "Skip for now"}
        </ContinueButton>
      }
    >
      <div className="space-y-3 rounded-card bg-surface p-5">
        <div className="flex items-start gap-4">
          <Calendar aria-hidden className="mt-0.5 size-5 text-fg-secondary" />
          <div className="min-w-0 flex-1">
            <p className="text-ui font-semibold text-fg">Use macOS Calendar</p>
            <p className="mt-1 text-ui text-fg-secondary">
              Google, Outlook and iCloud accounts you've added to the Calendar
              app on this Mac.
            </p>
          </div>
        </div>
        {!view ? (
          <p className="text-ui text-fg-secondary">
            {error ?? "Checking Calendar…"}
          </p>
        ) : (
          <div aria-live="polite" className="space-y-2">
            {view.action === "connect" ? (
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void connect()}
              >
                Use macOS Calendar
              </Button>
            ) : (
              <p
                className={cn(
                  "text-ui",
                  view.tone === "success"
                    ? "text-success"
                    : "text-fg-secondary",
                )}
              >
                {view.text}
              </p>
            )}
            {view.action === "connect" &&
              status &&
              connectAsksMacOS(status) && (
                <p className="text-caption text-fg-secondary">
                  macOS will ask whether Murmur may read your calendars.
                </p>
              )}
            {view.note && view.action !== "disconnect" && (
              <p className="text-caption text-fg-secondary">{view.note}</p>
            )}
            {view.showSystemSettings && view.action === "connect" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void hub.openSystemSettings("calendars")}
              >
                Open System Settings
              </Button>
            )}
            {error && (
              <p role="alert" className="text-caption text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </SplitScreen>
  );
}
