// Shortcuts (reference: Settings → General → Shortcuts “Change”). One card per action.
// Push-to-talk and the optional last-transcript shortcuts (Stage 6B) are configurable: the
// recorder registers a combination with macOS before saving it, and the previous binding stays
// registered if that fails. Hands-free and Cancel are shown as the fixed bindings they are.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronRight, Pencil, Trash2 } from "lucide-react";
import {
  SHORTCUT_ACTIONS as ACTIONS,
  type ShortcutAction,
  type StatusInfo,
} from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Kbd,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  DEFAULT_SHORTCUT,
  recordKey,
  SHORTCUT_WARNINGS,
  shortcutMessage,
} from "../model/settings.ts";
import type { Update } from "./common.tsx";
import { EditingConflictLine } from "./editing-conflict.tsx";

export type ShortcutMessage = {
  tone: "danger" | "success" | "warning";
  text: string;
} | null;

/**
 * Click, then press the new combination. Esc (or leaving the field) cancels and keeps the
 * current shortcut. While it listens, Murmur's own shortcuts are paused so a combination Murmur
 * already holds reaches the field instead of starting a dictation. `save` validates and
 * registers the combination with macOS before it is stored, and returns whether it was saved.
 */
export function ShortcutRecorder({
  id,
  name,
  current,
  save,
  onMessage,
  inline = false,
  placeholder = "Not set",
  pencil = true,
}: {
  id: string;
  name: string;
  current: string | null;
  save: (combo: string) => Promise<boolean>;
  onMessage: (m: ShortcutMessage) => void;
  /** Inside an ActionField (which draws the field), rather than being the field. */
  inline?: boolean;
  /** Shown when no shortcut is set. */
  placeholder?: string;
  /** The pencil after the keys (not in the Scratchpad page's capsule). */
  pencil?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState("");
  const [busy, setBusy] = useState(false);
  const listening = useRef(false);
  const listen = (on: boolean) => {
    if (listening.current === on) return;
    listening.current = on;
    void hub.suspendShortcuts(on);
  };
  // Never leave Murmur's shortcuts paused behind a closed dialog.
  useEffect(() => () => listen(false), []);
  const stop = () => {
    setRecording(false);
    setHeld("");
    listen(false);
  };
  const tryCombo = async (combo: string) => {
    setBusy(true);
    try {
      if (await save(combo)) stop();
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (busy || e.repeat) return;
    const r = recordKey(e);
    if (r.kind === "modifiers") setHeld(r.preview);
    else if (r.kind === "cancel") {
      stop();
      onMessage(null);
    } else if (r.kind === "unsupported")
      onMessage({ tone: "danger", text: shortcutMessage("unknown key") });
    else void tryCombo(r.combo);
  };
  return (
    <button
      type="button"
      id={id}
      data-shortcut-recording={recording || undefined}
      aria-describedby={`${id}-desc`}
      aria-label={
        recording
          ? "Recording a new shortcut. Press the keys, or Esc to cancel."
          : current
            ? `${name} shortcut ${current}. Press to change.`
            : `${name}: no shortcut. Press to set one.`
      }
      onClick={() => {
        if (recording) return;
        onMessage(null);
        setRecording(true);
        listen(true);
      }}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (!recording) return;
        // Modifiers still held after a key-up.
        setHeld(
          [
            e.ctrlKey && "ctrl",
            e.altKey && "opt",
            e.shiftKey && "shift",
            e.metaKey && "cmd",
          ]
            .filter(Boolean)
            .join("+"),
        );
      }}
      onBlur={() => recording && stop()}
      className={cn(
        "no-drag flex items-center gap-2 text-ui",
        inline
          ? "h-full min-w-0 flex-1 rounded-l-md pl-1.5 pr-1"
          : // Reference field: 215 × 43 pt, white, hairline edge, keycaps left, pencil right.
            cn(
              "h-[43px] w-[215px] shrink-0 rounded-md pl-1.5 pr-3 transition-shadow max-[700px]:w-full",
              recording
                ? "bg-accent-faint shadow-[inset_0_0_0_1.5px_var(--m-accent)]"
                : "bg-modal shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] hover:shadow-[inset_0_0_0_1px_var(--m-fg-tertiary)]",
            ),
      )}
    >
      <span className="flex min-w-0 flex-1 items-center">
        {recording ? (
          held ? (
            <Kbd combo={held} />
          ) : (
            <span className="pl-1.5 text-fg-secondary">Press the keys…</span>
          )
        ) : current ? (
          <Kbd combo={current} />
        ) : (
          <span className="truncate pl-1.5 text-fg-secondary">
            {placeholder}
          </span>
        )}
      </span>
      {!recording && pencil && (
        <Pencil className="size-[18px] shrink-0 text-fg" aria-hidden />
      )}
    </button>
  );
}

/** The field for an optional shortcut: recorder, plus a delete button when one is set. */
export function ActionField({
  action,
  current,
  save,
  clear,
  onMessage,
  placeholder,
  variant = "field",
}: {
  action: ShortcutAction;
  current: string | null;
  save: (combo: string) => Promise<boolean>;
  clear: () => void;
  onMessage: (m: ShortcutMessage) => void;
  placeholder?: string;
  /** "pill": the Scratchpad page header's grey 189 × 34 pt capsule (reference 12). */
  variant?: "field" | "pill";
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center pr-1.5 transition-shadow",
        variant === "pill"
          ? "h-[34px] min-w-[189px] rounded-full bg-surface pl-2 hover:bg-surface-hover"
          : cn(
              "h-[43px] w-[215px] rounded-md bg-modal max-[700px]:w-full",
              "shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] hover:shadow-[inset_0_0_0_1px_var(--m-fg-tertiary)]",
            ),
        "has-[[data-shortcut-recording]]:bg-accent-faint has-[[data-shortcut-recording]]:shadow-[inset_0_0_0_1.5px_var(--m-accent)]",
      )}
    >
      <ShortcutRecorder
        id={`shortcut-${action}`}
        name={ACTION_LABELS[action].title}
        current={current}
        save={save}
        onMessage={onMessage}
        placeholder={placeholder}
        pencil={variant !== "pill"}
        inline
      />
      {current && (
        <button
          type="button"
          aria-label={`Remove the ${ACTION_LABELS[action].title} shortcut`}
          onClick={clear}
          className="no-drag flex size-7 shrink-0 items-center justify-center rounded-sm text-fg hover:bg-surface-hover"
        >
          <Trash2 className="size-[17px]" aria-hidden />
        </button>
      )}
    </div>
  );
}

const ACTION_LABELS: Record<
  ShortcutAction,
  { title: string; description: string }
> = {
  pasteLast: {
    title: "Paste last transcript",
    description: "Paste the last thing you dictated.",
  },
  copyLast: {
    title: "Copy last transcript",
    description: "Copy the last thing you dictated.",
  },
  copyOriginal: {
    title: "Copy original words",
    description: "Copy what you said before cleanup and snippets changed it.",
  },
  openScratchpad: {
    title: "Open Scratchpad",
    description: "Open or close the Scratchpad note window from any app.",
  },
  transformViewChanges: {
    title: "Transform view changes",
    description: "Show the last Transform again: what changed, with Copy.",
  },
  commandMode: {
    title: "Command Mode",
    description:
      "Select text, hold this and say what to do with it (or just ask). The result opens in the Transform panel.",
  },
  pressEnter: {
    title: "Press Enter",
    description:
      "Presses Return to send a message. During a dictation, it stops it and sends once the text is pasted.",
  },
  startNotetaker: {
    title: "Join meeting / start Notetaker",
    description: "Start a meeting recording in Notetaker (after setup).",
  },
};

export function MessageLine({ message }: { message: ShortcutMessage }) {
  if (!message) return null;
  return (
    <span
      role={message.tone === "danger" ? "alert" : "status"}
      className={cn(
        "mt-1.5 block",
        message.tone === "danger" && "text-danger",
        message.tone === "success" && "text-success",
        message.tone === "warning" && "text-warning",
      )}
    >
      {message.text}
    </span>
  );
}

/** A fixed binding shown in the same field shape (not interactive). */
function FixedBinding({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[43px] w-[215px] shrink-0 items-center gap-2 rounded-md bg-modal px-3 text-ui text-fg-secondary shadow-[inset_0_0_0_1px_var(--m-hairline)] max-[700px]:w-full">
      {children}
    </div>
  );
}

function Card({
  title,
  description,
  descriptionId,
  control,
}: {
  title: ReactNode;
  description: ReactNode;
  descriptionId?: string;
  control: ReactNode;
}) {
  return (
    <section className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[10px] bg-surface px-6 py-4">
      <div className="min-w-48 flex-1">
        <h3 className="text-ui font-semibold text-fg">{title}</h3>
        <div id={descriptionId} className="mt-1.5 text-ui text-fg-secondary">
          {description}
        </div>
      </div>
      {control}
    </section>
  );
}

/** The cards themselves (also used by Onboarding's shortcut step). */
/** Checks, registers and saves an optional shortcut; reports through `say`. */
export async function saveActionShortcut(
  action: ShortcutAction,
  combo: string,
  say: (m: ShortcutMessage) => void,
): Promise<boolean> {
  const check = await hub.checkShortcut(combo, action);
  if (check.errors.length) {
    say({ tone: "danger", text: shortcutMessage(check.errors[0]) });
    return false;
  }
  try {
    await hub.setActionShortcut(action, check.normalized ?? combo);
  } catch (e) {
    say({
      tone: "danger",
      text: `${ipcErrorMessage(e)} Nothing was changed.`,
    });
    return false;
  }
  say({ tone: "success", text: "Saved. It works in any app now." });
  return true;
}

export async function clearActionShortcut(
  action: ShortcutAction,
  say: (m: ShortcutMessage) => void,
): Promise<void> {
  try {
    await hub.setActionShortcut(action, null);
    say({ tone: "success", text: "Removed." });
  } catch (e) {
    say({ tone: "danger", text: ipcErrorMessage(e) });
  }
}

export function ShortcutCards({
  settings,
  update,
  status,
  message,
  onMessage,
  showActions = false,
  openTransforms,
}: {
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
  message: ShortcutMessage;
  onMessage: (m: ShortcutMessage) => void;
  /** The optional last-transcript shortcuts (Settings; not Onboarding). */
  showActions?: boolean;
  openTransforms?: () => void;
}) {
  const [openedAt] = useState(() => Date.now());
  const [actionMessages, setActionMessages] = useState<
    Partial<Record<ShortcutAction, ShortcutMessage>>
  >({});
  const actionMessage = (action: ShortcutAction) => (m: ShortcutMessage) =>
    setActionMessages((all) => ({ ...all, [action]: m }));
  const savePushToTalk = async (combo: string) => {
    const check = await hub.checkShortcut(combo, "pushToTalk");
    if (check.errors.length) {
      onMessage({ tone: "danger", text: shortcutMessage(check.errors[0]) });
      return false;
    }
    try {
      await update({ shortcut: check.normalized ?? combo });
    } catch (e) {
      onMessage({
        tone: "danger",
        text: `${ipcErrorMessage(e)} Your shortcut is unchanged.`,
      });
      return false;
    }
    const warning = check.warnings
      .map((w) => SHORTCUT_WARNINGS[w])
      .find(Boolean);
    onMessage(
      warning
        ? { tone: "warning", text: `Saved. ${warning}` }
        : { tone: "success", text: "Saved. The new shortcut works now." },
    );
    return true;
  };
  const saveAction = (action: ShortcutAction) => (combo: string) =>
    saveActionShortcut(action, combo, actionMessage(action));
  const clearAction = (action: ShortcutAction) => () =>
    clearActionShortcut(action, actionMessage(action));
  const current = status?.shortcut.registered
    ? status.shortcut.combo
    : settings.shortcut;
  const heard = (status?.lastHotkeyAt ?? 0) > openedAt;
  const state = !status
    ? null
    : !status.shortcut.registered
      ? {
          tone: "danger" as const,
          text: status.shortcut.error
            ? `Not active: ${shortcutMessage(status.shortcut.error)}`
            : "Not active.",
        }
      : heard
        ? { tone: "success" as const, text: "Working: Murmur heard it." }
        : null;
  return (
    <div className="space-y-6">
      <Card
        title={<label htmlFor="shortcut-recorder">Push to talk</label>}
        descriptionId="shortcut-recorder-desc"
        description={
          <>
            Hold to dictate, release to insert.
            {message ? (
              <MessageLine message={message} />
            ) : (
              // A line only when something is wrong or Murmur just heard the shortcut.
              state && (
                <span
                  role="status"
                  className={cn(
                    "mt-1.5 block",
                    state.tone === "danger" && "text-danger",
                    state.tone === "success" && "text-success",
                  )}
                >
                  {state.text}
                </span>
              )
            )}
            {!message && <EditingConflictLine combo={current} />}
          </>
        }
        control={
          <ShortcutRecorder
            id="shortcut-recorder"
            name="Push to talk"
            current={current}
            save={savePushToTalk}
            onMessage={onMessage}
          />
        }
      />
      <Card
        title="Hands-free mode"
        description="Double-tap to start, press again to stop."
        control={
          <FixedBinding>
            Double tap <Kbd combo={current} />
          </FixedBinding>
        }
      />
      {showActions && openTransforms && (
        // Reference 17: a link row; each Transform's shortcut is set on the Transforms page.
        <button
          type="button"
          onClick={openTransforms}
          className="no-drag flex w-full items-center gap-4 rounded-list bg-surface px-6 py-5 text-left hover:bg-surface-hover"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-fg">Transform</span>
            <span className="mt-1 block text-caption text-fg-secondary">
              Set the shortcuts for Polish, Prompt Engineer and your own
              Transforms on the Transforms page
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-fg" aria-hidden />
        </button>
      )}
      {showActions &&
        ACTIONS.map((action) => {
          const bound = status?.actions[action] ?? null;
          const saved = settings.shortcuts[action];
          return (
            <Card
              key={action}
              title={
                <label htmlFor={`shortcut-${action}`}>
                  {ACTION_LABELS[action].title}
                </label>
              }
              descriptionId={`shortcut-${action}-desc`}
              description={
                <>
                  {ACTION_LABELS[action].description}
                  {actionMessages[action] ? (
                    <MessageLine message={actionMessages[action]!} />
                  ) : (
                    bound &&
                    !bound.registered && (
                      <span role="status" className="mt-1.5 block text-danger">
                        Not active
                        {bound.error
                          ? `: ${shortcutMessage(bound.error)}`
                          : "."}
                      </span>
                    )
                  )}
                  {!actionMessages[action] && (
                    <EditingConflictLine combo={bound?.combo ?? saved} />
                  )}
                </>
              }
              control={
                <ActionField
                  action={action}
                  current={bound?.combo ?? saved}
                  save={saveAction(action)}
                  clear={() => void clearAction(action)()}
                  onMessage={actionMessage(action)}
                />
              }
            />
          );
        })}
      <Card
        title="Cancel"
        description="Discard the recording while dictating."
        control={
          <FixedBinding>
            <Kbd combo="esc" />
          </FixedBinding>
        }
      />
      <p className="px-1 text-caption text-fg-secondary">
        Shortcuts need Control, Option or Command with a key. Hands-free stops
        after 20 minutes. fn (Globe) or Right Option on their own would need
        Input Monitoring access, which this version doesn't use.
      </p>
    </div>
  );
}

/**
 * Restores the default push-to-talk shortcut (and, in Settings, removes the optional ones);
 * reports the result through the same message line.
 */
export async function resetShortcut(
  update: Update,
  onMessage: (m: ShortcutMessage) => void,
  actions = false,
): Promise<void> {
  try {
    await update({ shortcut: DEFAULT_SHORTCUT });
    if (actions)
      for (const action of ACTIONS) await hub.setActionShortcut(action, null);
    onMessage({
      tone: "success",
      text: actions
        ? "Reset to the default shortcuts."
        : "Reset to the default shortcut.",
    });
  } catch (e) {
    onMessage({
      tone: "danger",
      text: `${ipcErrorMessage(e)} Your shortcut is unchanged.`,
    });
  }
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  settings,
  update,
  status,
  openTransforms,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
  openTransforms?: () => void;
}) {
  const [message, setMessage] = useState<ShortcutMessage>(null);
  const isDefault =
    settings.shortcut.toLowerCase() === DEFAULT_SHORTCUT &&
    ACTIONS.every((a) => settings.shortcuts[a] === null);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setMessage(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        // Reference: 664 × 588 pt, sheet-coloured.
        className="h-[min(588px,calc(100vh-48px))] w-[min(664px,calc(100vw-48px))] bg-sheet"
        // Esc while recording cancels the recording, not the dialog.
        onEscapeKeyDown={(e) => {
          if (document.activeElement?.closest("[data-shortcut-recording]"))
            e.preventDefault();
        }}
      >
        <DialogHeader
          title="Shortcuts"
          description="Choose how you start and stop dictation."
        />
        <DialogBody>
          {/* Cards sit 40 pt in from the dialog edge (reference). */}
          <div className="px-4 py-6">
            <ShortcutCards
              settings={settings}
              update={update}
              status={status}
              message={message}
              onMessage={setMessage}
              showActions
              openTransforms={
                openTransforms &&
                (() => {
                  onOpenChange(false);
                  openTransforms();
                })
              }
            />
          </div>
        </DialogBody>
        <DialogFooter
          start={
            <Button
              disabled={isDefault}
              className="ml-4"
              onClick={() => void resetShortcut(update, setMessage, true)}
            >
              Reset to default
            </Button>
          }
        >
          <Button
            variant="primary"
            className="mr-4"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Onboarding's shortcut step: the same cards, with Reset below instead of a dialog footer. */
export function ShortcutSetup(props: {
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
}) {
  const [message, setMessage] = useState<ShortcutMessage>(null);
  return (
    <div className="space-y-4">
      <ShortcutCards {...props} message={message} onMessage={setMessage} />
      <Button
        disabled={props.settings.shortcut.toLowerCase() === DEFAULT_SHORTCUT}
        onClick={() => void resetShortcut(props.update, setMessage)}
      >
        Reset to default
      </Button>
    </div>
  );
}
