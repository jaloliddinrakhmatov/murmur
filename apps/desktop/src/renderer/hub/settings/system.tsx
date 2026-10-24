// Settings sections that deal with the Mac: General (shortcut, microphone, language,
// appearance) and System (the Murmur bar, pasting).
import { useCallback, useEffect, useState } from "react";
import type {
  AppInfo,
  LoginItemInfo,
  ResetResult,
  StatusInfo,
} from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  Checkbox,
  describedBy,
  Dialog,
  DialogClose,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  Kbd,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  Switch,
  useToast,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { MICROPHONE_STATE, shortcutMessage } from "../model/settings.ts";
import type { SettingsDialog } from "../model/settings-sections.ts";
import { StatusText, useSave, type Update } from "./common.tsx";
import { ShortcutsDialog } from "./shortcuts-dialog.tsx";
import { LanguageRow } from "./language-dialog.tsx";
import { MicrophoneRow } from "./microphone-dialog.tsx";

interface SectionProps {
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
  refresh: () => void;
}

/**
 * General (reference layout): one card with the dictation shortcut, the microphone, the
 * dictation language and appearance. Shortcut and language open focused dialogs.
 */
export function GeneralSection({
  settings,
  update,
  status,
  refresh,
  about,
  dialog,
  onDialog,
  openTransforms,
}: SectionProps & {
  about: AppInfo | null;
  dialog: SettingsDialog | null;
  onDialog: (d: SettingsDialog | null) => void;
  /** Shortcuts → "Transform": their shortcuts are set on the Transforms page. */
  openTransforms?: () => void;
}) {
  const save = useSave(update);
  const combo = status?.shortcut.combo || settings.shortcut;
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Shortcuts"
          describes="shortcuts-change"
          description={
            status && !status.shortcut.registered ? (
              <span className="text-danger">
                Not active
                {status.shortcut.error
                  ? `: ${shortcutMessage(status.shortcut.error)}`
                  : "."}
              </span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                Hold <Kbd combo={combo} /> and speak.
              </span>
            )
          }
          control={
            <Button
              id="shortcuts-change"
              variant="secondary"
              className="w-[164px]"
              aria-describedby={describedBy("shortcuts-change")}
              onClick={() => onDialog("shortcuts")}
            >
              Change
            </Button>
          }
        />
        <MicrophoneRow
          status={status}
          refresh={refresh}
          about={about}
          open={dialog === "microphone"}
          onOpenChange={(o) => onDialog(o ? "microphone" : null)}
        />
        <LanguageRow
          settings={settings}
          update={update}
          open={dialog === "language"}
          onOpenChange={(o) => onDialog(o ? "language" : null)}
        />
        <SettingsRow
          label="Appearance"
          describes="appearance"
          description="Follow macOS, or keep Murmur light or dark."
          control={
            <SegmentedControl
              label="Appearance"
              describedBy={describedBy("appearance")}
              value={settings.appearance}
              onChange={(v) => void save({ appearance: v })}
              options={[
                { value: "system", label: "Auto" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          }
        />
      </SettingsGroup>
      <ShortcutsDialog
        open={dialog === "shortcuts"}
        onOpenChange={(o) => onDialog(o ? "shortcuts" : null)}
        settings={settings}
        update={update}
        status={status}
        openTransforms={openTransforms}
      />
    </>
  );
}

/** System (reference): how Murmur behaves on the Mac. Only settings Murmur has are shown. */
export function SystemSection({
  settings,
  update,
  status,
  refresh,
  onReset,
}: SectionProps & { onReset: () => void }) {
  const save = useSave(update);
  const [resetting, setResetting] = useState(false);
  return (
    <>
      <SettingsGroup title="App settings">
        <LoginItemRow />
        <SettingsRow
          label="Show the Murmur bar at all times"
          htmlFor="capsule-visibility"
          description="The small status bar at the bottom of the screen. Turned off, it appears only while you dictate."
          control={
            <Switch
              id="capsule-visibility"
              label="Show the Murmur bar at all times"
              describedBy={describedBy("capsule-visibility")}
              checked={settings.capsule === "always"}
              onCheckedChange={(on) =>
                void save({ capsule: on ? "always" : "whileActive" })
              }
            />
          }
        />
        <SettingsRow
          label="Show Murmur in the Dock"
          htmlFor="show-in-dock"
          description="Murmur is always in the menu bar. Without the Dock icon, open it from there, or open the app again from Finder or Spotlight."
          control={
            <Switch
              id="show-in-dock"
              label="Show Murmur in the Dock"
              describedBy={describedBy("show-in-dock")}
              checked={settings.system.showInDock}
              onCheckedChange={(on) =>
                void save({ system: { showInDock: on } })
              }
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Sound">
        <SettingsRow
          label="Dictation sounds"
          htmlFor="dictation-sounds"
          description="A short sound when a recording stops and when a dictation is done or fails. Never while the microphone is on, so Murmur doesn't record its own sounds."
          control={
            <Switch
              id="dictation-sounds"
              label="Dictation sounds"
              describedBy={describedBy("dictation-sounds")}
              checked={settings.system.sounds}
              onCheckedChange={(on) => void save({ system: { sounds: on } })}
            />
          }
        />
        <SettingsRow
          label="Mute other audio while dictating"
          htmlFor="mute-while-dictating"
          description="Mutes your Mac's sound while the microphone records a dictation, and turns it back on afterwards (only if Murmur muted it). Not while a meeting records."
          control={
            <Switch
              id="mute-while-dictating"
              label="Mute other audio while dictating"
              describedBy={describedBy("mute-while-dictating")}
              checked={settings.system.muteWhileDictating}
              onCheckedChange={(on) =>
                void save({ system: { muteWhileDictating: on } })
              }
            />
          }
        />
      </SettingsGroup>
      <PastePermissionGroup status={status} refresh={refresh} />
      <SettingsGroup title="Extras">
        <SettingsRow
          label="Auto-add to dictionary"
          htmlFor="auto-add-corrections"
          description="After a dictation is pasted, Murmur checks that text once more (within two minutes, only if the same field is still in front). Words you re-spelled are added to your dictionary, and it tells you. Nothing else is read or kept. Needs Accessibility access."
          control={
            <Switch
              id="auto-add-corrections"
              label="Auto-add to dictionary"
              describedBy={describedBy("auto-add-corrections")}
              checked={settings.context.autoAddCorrections}
              onCheckedChange={(v) =>
                void save({ context: { autoAddCorrections: v } })
              }
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Scratchpad">
        <SettingsRow
          label="Scratchpad open behavior"
          description={
            settings.scratchpad.openBehavior === "resume"
              ? "Resume last note"
              : "Start a new note"
          }
          control={
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" className="w-[164px]">
                  Customize
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuRadioGroup
                  value={settings.scratchpad.openBehavior}
                  onValueChange={(v) =>
                    void save({
                      scratchpad: { openBehavior: v as "resume" | "new" },
                    })
                  }
                >
                  <MenuRadioItem value="resume">Resume last note</MenuRadioItem>
                  <MenuRadioItem value="new">Start a new note</MenuRadioItem>
                </MenuRadioGroup>
              </MenuContent>
            </Menu>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Data">
        <SettingsRow
          label="Reset Murmur"
          description="Deletes your settings, History, recordings and API keys, then starts setup again."
          control={
            <Button
              variant="secondary"
              className="w-[164px]"
              onClick={() => setResetting(true)}
            >
              Reset…
            </Button>
          }
        />
      </SettingsGroup>
      <ResetDialog
        open={resetting}
        onOpenChange={setResetting}
        onDone={onReset}
      />
    </>
  );
}

/** Launch at login, as macOS reports it; the switch shows only what macOS confirmed. */
function LoginItemRow() {
  const toast = useToast();
  const [info, setInfo] = useState<LoginItemInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      void hub
        .loginItem()
        .then(setInfo)
        .catch(() => setInfo(null)),
    [],
  );
  useEffect(() => {
    load();
    // The user may change it in System Settings while Murmur is open.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);
  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      setInfo(await hub.setLoginItem(enabled));
    } catch (e) {
      toast({
        title: "Couldn't change launch at login",
        description: ipcErrorMessage(e),
        tone: "error",
      });
      load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      label="Launch Murmur at login"
      htmlFor="launch-at-login"
      description={
        !info
          ? undefined
          : !info.supported
            ? "Available in the installed Murmur app (this is a development build)."
            : info.needsApproval
              ? "Waiting for your approval in System Settings → General → Login Items."
              : "Starts Murmur in the menu bar when you log in to your Mac."
      }
      control={
        <>
          {info?.needsApproval && (
            <Button onClick={() => void hub.openSystemSettings("login-items")}>
              Open Login Items
            </Button>
          )}
          <Switch
            id="launch-at-login"
            label="Launch Murmur at login"
            describedBy={describedBy("launch-at-login")}
            checked={Boolean(info?.enabled || info?.needsApproval)}
            disabled={!info?.supported || busy}
            onCheckedChange={(on) => void change(on)}
          />
        </>
      }
    />
  );
}

/**
 * Reset needs a second, deliberate step: ticking that you understand. The library is kept
 * unless asked. On success Murmur goes straight to setup; partial failures are listed first.
 */
function ResetDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [library, setLibrary] = useState(false);
  const [notes, setNotes] = useState(false);
  const [meetings, setMeetings] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setLibrary(false);
      setNotes(false);
      setMeetings(false);
      setUnderstood(false);
      setResult(null);
      setError(null);
    }
  }, [open]);
  const restart = () => {
    onOpenChange(false);
    onDone();
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await hub.resetApp({ library, notes, meetings });
      if (r.ok && !r.shortcutKept && !r.staleMcpApps.length) restart();
      else setResult(r);
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="md" role="alertdialog">
        <DialogHeader
          title="Reset Murmur?"
          description="This can't be undone."
        />
        {result ? (
          <div role="status" className="space-y-2 text-ui text-fg">
            {result.ok ? (
              <p>Murmur was reset.</p>
            ) : (
              <p>
                Murmur was reset, except:{" "}
                {result.failed.map((f) => RESET_STEPS[f]).join(", ")}. You can
                try again.
              </p>
            )}
            {result.staleMcpApps.length > 0 && (
              <p>
                Murmur's access for {result.staleMcpApps.join(" and ")} was
                revoked, so the Murmur entry you added there no longer works.
                Murmur didn't change those apps' settings; remove the entry in{" "}
                {result.staleMcpApps.length > 1 ? "each app" : "that app"} if
                you don't want it.
              </p>
            )}
            {result.shortcutKept && (
              <p>
                The default shortcut is in use by another app, so your current
                shortcut was kept.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <ul className="list-disc space-y-1 pl-5 text-ui text-fg">
              <li>All settings return to their defaults.</li>
              <li>History and the recordings kept for retrying are deleted.</li>
              <li>Saved API keys are removed from this Mac.</li>
              <li>You are signed out of your Murmur account.</li>
              <li>
                MCP is turned off and its access tokens are revoked. Claude or
                Cursor entries you added stop working.
              </li>
              <li>Setup starts again.</li>
            </ul>
            <Checkbox
              checked={library}
              onCheckedChange={setLibrary}
              label="Also delete my dictionary and snippets"
              description="Otherwise they are kept."
            />
            <Checkbox
              checked={notes}
              onCheckedChange={setNotes}
              label="Delete Scratchpad notes"
              description="Every note on this Mac is deleted and the note window closes. Otherwise your notes are kept."
            />
            <Checkbox
              checked={meetings}
              onCheckedChange={setMeetings}
              label="Delete Notetaker meetings"
              description="Every meeting and its notes on this Mac are deleted. Otherwise your meetings are kept."
            />
            <Checkbox
              checked={understood}
              onCheckedChange={setUnderstood}
              label="I understand this deletes my data on this Mac"
            />
            <DialogError message={error} />
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button variant="primary" onClick={restart}>
              Continue to setup
            </Button>
          ) : (
            <>
              <DialogClose asChild>
                <Button disabled={busy}>Cancel</Button>
              </DialogClose>
              <Button
                variant="danger"
                disabled={!understood}
                loading={busy}
                onClick={() => void run()}
              >
                Reset Murmur
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const RESET_STEPS: Record<ResetResult["failed"][number], string> = {
  recording: "stopping the recording",
  history: "deleting History",
  dictionary: "deleting the dictionary",
  snippets: "deleting snippets",
  notes: "deleting Scratchpad notes",
  meetings: "deleting Notetaker meetings",
  keys: "removing API keys",
  account: "signing out of your Murmur account",
  mcp: "revoking MCP access",
  settings: "restoring settings",
};

/** Accessibility permission for pasting (General, and Onboarding's permissions step). */
export function PastePermissionGroup({
  status,
  refresh,
}: Pick<SectionProps, "status" | "refresh">) {
  const p = status?.permissions;
  return (
    <SettingsGroup title="Inserting text">
      <SettingsRow
        label="Paste into other apps"
        description={
          p?.accessibility
            ? "Accessibility access is on, so Murmur pastes where your cursor is."
            : "Optional. Accessibility access lets Murmur paste automatically; without it, dictation still works and each result is copied for you to paste with ⌘V."
        }
        control={
          !p ? null : p.accessibility ? (
            <StatusText tone="success" live>
              Allowed
            </StatusText>
          ) : (
            <>
              <StatusText tone="warning" live>
                Off
              </StatusText>
              <Button
                variant="primary"
                onClick={() => void hub.requestAccessibility().then(refresh)}
              >
                Allow…
              </Button>
              <Button
                onClick={() => void hub.openSystemSettings("accessibility")}
              >
                System Settings
              </Button>
            </>
          )
        }
      />
    </SettingsGroup>
  );
}

/** Microphone permission with the action macOS allows (Microphone, and Onboarding). */
export function MicrophoneAccessGroup({
  status,
  refresh,
  about,
}: Pick<SectionProps, "status" | "refresh"> & { about: AppInfo | null }) {
  const mic = status?.permissions.microphone;
  const state = mic ? MICROPHONE_STATE[mic] : null;
  return (
    <SettingsGroup title="Access">
      <SettingsRow
        label="Microphone access"
        description={
          state && (
            <>
              {state.help}
              {mic === "denied" && about && !about.packaged && (
                <> In development builds, macOS lists Murmur as “Electron”.</>
              )}
            </>
          )
        }
        control={
          state && (
            <>
              <StatusText tone={state.tone} live>
                {state.label}
              </StatusText>
              {mic === "not-determined" && (
                <Button
                  variant="primary"
                  onClick={() => void hub.requestMicrophone().then(refresh)}
                >
                  Allow microphone…
                </Button>
              )}
              {mic === "denied" && (
                <Button
                  onClick={() => void hub.openSystemSettings("microphone")}
                >
                  Open System Settings
                </Button>
              )}
            </>
          )
        }
      />
    </SettingsGroup>
  );
}
