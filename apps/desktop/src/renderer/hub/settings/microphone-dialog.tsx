// Settings → General → Microphone (Stage 6B; reference: the Microphone dialog). Cards choose the
// device dictation records from; the live meter shows real input levels from the audio renderer
// (RMS of the last 50 ms, never audio), only while the dialog is open and visible.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronRight } from "lucide-react";
import type {
  AppInfo,
  MicrophonesInfo,
  StatusInfo,
} from "../../../shared/ipc.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  describedBy,
  SettingsRow,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  EMPTY_METER,
  litBars,
  METER_BARS,
  meterHint,
  microphoneCards,
  microphoneSummary,
  nextMeter,
  type MeterState,
  type MicCard,
} from "../model/microphone.ts";
import { MICROPHONE_STATE } from "../model/settings.ts";

/** The device list from the main process, refreshed on device changes and window focus. */
export function useMicrophones() {
  const [info, setInfo] = useState<MicrophonesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    hub.microphones().then(
      (i) => {
        setInfo(i);
        setError(null);
      },
      (e) => setError(ipcErrorMessage(e)),
    );
  }, []);
  useEffect(() => {
    load();
    const offDevices = hub.onMicrophonesChanged(load);
    // Access granted or revoked in System Settings: names and devices appear or go.
    const offStatus = hub.onStatusChanged(load);
    window.addEventListener("focus", load);
    return () => {
      offDevices();
      offStatus();
      window.removeEventListener("focus", load);
    };
  }, [load]);
  return { info, setInfo, error, reload: load };
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

type PreviewState =
  "off" | "starting" | "live" | "recording" | "paused" | "ended" | "error";

/**
 * A level preview owned by this window while `active`. It starts again when `restartKey`
 * changes (devices plugged in or removed, another selection), and always stops on cleanup.
 */
export function useMicPreview(active: boolean, restartKey: string) {
  const [meter, setMeter] = useState<MeterState>(EMPTY_METER);
  const [state, setState] = useState<PreviewState>("off");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMeter(EMPTY_METER);
    setError(null);
    if (!active) {
      setState("off");
      return;
    }
    let session = 0;
    let cancelled = false;
    let m = EMPTY_METER;
    const off = hub.onMicPreview((e) => {
      if (e.session !== session) return;
      if (e.type === "level") {
        m = nextMeter(m, e, Date.now());
        setMeter(m);
        setState(e.source === "recording" ? "recording" : "live");
      } else {
        setState(e.state === "stopped" ? "off" : e.state);
        setError(e.error);
      }
    });
    setState("starting");
    hub.startMicPreview().then(
      ({ session: s }) => {
        if (cancelled) void hub.stopMicPreview(s);
        else session = s;
      },
      (e) => {
        setState("error");
        setError(ipcErrorMessage(e));
      },
    );
    return () => {
      cancelled = true;
      off();
      if (session) void hub.stopMicPreview(session);
    };
  }, [active, restartKey]);
  return { meter, state, error };
}

/** Seven bars, lit from the bottom (reference); the top one turns red while clipping. */
function LevelMeter({ meter }: { meter: MeterState }) {
  const lit = litBars(meter.position);
  const clipping = meter.clipUntil > meter.at;
  const percent = Math.round(meter.position * 100);
  return (
    <div
      role="meter"
      aria-label="Input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={
        meter.muted
          ? "Muted"
          : clipping
            ? "Too loud"
            : percent === 0
              ? "Silent"
              : `${percent}%`
      }
      data-meter-lit={lit}
      // Reference meter: 17.5 × 53.5 pt, seven 5.5 pt bars.
      className="flex h-[53.5px] w-[17.5px] shrink-0 flex-col-reverse justify-between"
    >
      {Array.from({ length: METER_BARS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-[5.5px] rounded-[1.5px]",
            i >= lit
              ? "bg-[var(--m-hairline-strong)]"
              : clipping && i === METER_BARS - 1
                ? "bg-danger"
                : "bg-accent",
          )}
        />
      ))}
    </div>
  );
}

function previewLine(
  state: PreviewState,
  error: string | null,
  meter: MeterState,
): string | null {
  if (state === "recording") return "Dictating now — showing its level.";
  if (state === "paused") return "Paused while you dictate.";
  if (state === "ended") return "This microphone stopped sending sound.";
  if (state === "error")
    return error === "NotAllowedError"
      ? "Murmur isn't allowed to use the microphone."
      : error === "NotReadableError"
        ? "Another app is using this microphone."
        : "Couldn't open this microphone.";
  if (state === "live") return meterHint(meter, meter.at) ?? "Speak to test.";
  return null;
}

function Card({
  card,
  onChoose,
  meter,
  line,
}: {
  card: MicCard;
  onChoose: (c: MicCard) => void;
  meter: MeterState | null;
  line: string | null;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={card.selected}
      data-mic-card={card.key}
      onClick={() => onChoose(card)}
      className={cn(
        // Reference cards: 464 pt wide, 8 pt corners, text 23 pt in; the metered card is as tall
        // as its meter plus 18 pt above and below (90 pt), the others 24 pt padding (98 pt).
        "no-drag flex w-full items-start gap-4 rounded-[8px] px-[23px] text-left transition-colors",
        meter ? "min-h-[90px] py-[18px]" : "py-[24px]",
        card.selected
          ? "bg-accent-faint shadow-[inset_0_0_0_1.5px_var(--m-accent)]"
          : "bg-surface hover:bg-surface-hover",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-semibold text-fg">
          {card.title}
        </span>
        {(line ?? card.detail) && (
          <span
            className={cn(
              "mt-2.5 block text-ui",
              card.connected ? "text-fg-secondary" : "text-danger",
            )}
            aria-live={meter ? "polite" : undefined}
          >
            {line ?? card.detail}
          </span>
        )}
      </span>
      {meter && <LevelMeter meter={meter} />}
    </button>
  );
}

export function MicrophoneDialog({
  open,
  onOpenChange,
  mics,
  status,
  refresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mics: ReturnType<typeof useMicrophones>;
  status: StatusInfo | null;
  refresh: () => void;
}) {
  const { info } = mics;
  const visible = useDocumentVisible();
  const [showOthers, setShowOthers] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granted = info?.permission === "granted";
  const restartKey = info
    ? `${info.next}|${info.selected?.id ?? ""}|${info.devices.map((d) => d.id).join(",")}`
    : "";
  const preview = useMicPreview(
    open && visible && granted && Boolean(info?.devices.length),
    restartKey,
  );
  const groupRef = useRef<HTMLDivElement>(null);
  const cards = info ? microphoneCards(info) : null;
  const choose = async (c: MicCard) => {
    if (c.selected) return;
    setError(null);
    try {
      mics.setInfo(await hub.selectMicrophone(c.value));
    } catch (e) {
      setError(ipcErrorMessage(e));
      mics.reload();
    }
  };
  // Arrow keys move between the cards (radio group pattern); Space or Enter chooses.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key))
      return;
    const radios = [
      ...(groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]') ??
        []),
    ];
    const i = radios.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    radios[(i + step + radios.length) % radios.length]?.focus();
  };
  const mic = status?.permissions.microphone ?? info?.permission;
  const line = previewLine(preview.state, preview.error, preview.meter);
  const renderCard = (c: MicCard) => (
    <Card
      key={c.key}
      card={c}
      onChoose={choose}
      meter={c.metered && preview.state !== "off" ? preview.meter : null}
      line={c.metered ? line : null}
    />
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        // Reference: 512 × 590 pt, sheet-coloured. `max-w` because class order, not position in
        // this string, decides between two width utilities.
        className="h-[min(590px,calc(100vh-48px))] max-w-[min(512px,calc(100vw-48px))] bg-sheet"
      >
        <DialogHeader title="Microphone" description="Used for dictation." />
        <DialogBody>
          {!info ? (
            <p className="py-6 text-ui text-fg-secondary">
              {mics.error ?? "Checking microphones…"}
            </p>
          ) : mic && mic !== "granted" ? (
            <div className="space-y-4 py-6 text-ui">
              <p className="text-fg">
                {MICROPHONE_STATE[mic].label}. {MICROPHONE_STATE[mic].help}
              </p>
              {mic === "not-determined" ? (
                <Button
                  variant="primary"
                  onClick={() => void hub.requestMicrophone().then(refresh)}
                >
                  Allow microphone…
                </Button>
              ) : (
                <Button
                  onClick={() => void hub.openSystemSettings("microphone")}
                >
                  Open System Settings
                </Button>
              )}
            </div>
          ) : !info.devices.length && !info.selected ? (
            <p className="py-6 text-ui text-fg-secondary">
              No microphone found. Connect one, or check System Settings → Sound
              → Input.
            </p>
          ) : (
            cards && (
              // Reference: the first card starts 120 pt below the dialog's top edge.
              <div className="pt-[26px]">
                <div
                  ref={groupRef}
                  role="radiogroup"
                  aria-label="Microphone for dictation"
                  onKeyDown={onKeyDown}
                  className="space-y-[8.5px]"
                >
                  {cards.primary.map(renderCard)}
                  {showOthers && cards.others.map(renderCard)}
                </div>
                {cards.others.length > 0 && (
                  <button
                    type="button"
                    aria-expanded={showOthers}
                    onClick={() => setShowOthers((v) => !v)}
                    className="no-drag ml-1 mt-[12px] flex items-center gap-1.5 rounded-sm text-caption text-fg hover:text-fg-secondary"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform",
                        showOthers && "rotate-90",
                      )}
                      aria-hidden
                    />
                    {showOthers
                      ? "Hide other devices"
                      : `Show other devices (${cards.others.length})`}
                  </button>
                )}
                {error && (
                  <p role="alert" className="mt-3 text-caption text-danger">
                    {error}
                  </p>
                )}
                {info.devices.some((d) => d.name === null) && (
                  <p className="mt-3 text-caption text-fg-secondary">
                    macOS shows microphone names once Murmur may use the
                    microphone.
                  </p>
                )}
              </div>
            )
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void hub.openSystemSettings("sound")}
          >
            Sound Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The microphone row in General: what dictation records from now, and a Change button for the
 * dialog (or the permission action macOS allows).
 */
export function MicrophoneRow({
  status,
  refresh,
  about,
  open,
  onOpenChange,
}: {
  status: StatusInfo | null;
  refresh: () => void;
  about: AppInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mics = useMicrophones();
  const mic = status?.permissions.microphone;
  const state = mic ? MICROPHONE_STATE[mic] : null;
  const info = mics.info;
  return (
    <>
      <SettingsRow
        label="Microphone"
        describes="microphone-change"
        description={
          !state ? undefined : mic !== "granted" ? (
            <>
              <span className="text-danger">{state.label}.</span> {state.help}
              {mic === "denied" && about && !about.packaged && (
                <> In development builds, macOS lists Murmur as “Electron”.</>
              )}
            </>
          ) : !info ? (
            "Checking…"
          ) : (
            <span
              className={cn(
                info.selected && !info.selectedAvailable && "text-danger",
              )}
            >
              {state.label} · {microphoneSummary(info)}
            </span>
          )
        }
        control={
          mic === "not-determined" ? (
            <Button
              variant="primary"
              className="w-[164px]"
              onClick={() => void hub.requestMicrophone().then(refresh)}
            >
              Allow microphone…
            </Button>
          ) : mic === "denied" ? (
            <Button
              variant="secondary"
              className="w-[164px]"
              onClick={() => void hub.openSystemSettings("microphone")}
            >
              Open System Settings
            </Button>
          ) : (
            <Button
              id="microphone-change"
              variant="secondary"
              className="w-[164px]"
              aria-describedby={describedBy("microphone-change")}
              onClick={() => onOpenChange(true)}
            >
              Change
            </Button>
          )
        }
      />
      <MicrophoneDialog
        open={open}
        onOpenChange={onOpenChange}
        mics={mics}
        status={status}
        refresh={refresh}
      />
    </>
  );
}
