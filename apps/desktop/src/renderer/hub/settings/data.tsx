// Settings sections about your data: Dictionary & snippets, History & privacy, About.
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Download, FolderOpen, Trash2 } from "lucide-react";
import type { AppInfo, SecureStorageInfo } from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  ConfirmDialog,
  describedBy,
  Select,
  SettingsGroup,
  SettingsRow,
  Switch,
  useToast,
} from "../ui/index.ts";
import { MurmurMark } from "../shell/shell.tsx";
import { ipcErrorMessage } from "../model/errors.ts";
import { privacyFlows, secureStorageText } from "../model/settings.ts";
import { StatusText, useSave, type Update } from "./common.tsx";

/** Count of rows from a list call, refreshed when the library or History changes. */
function useCount(
  load: () => Promise<number>,
  subscribe: (cb: () => void) => () => void,
) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    const run = () =>
      void load()
        .then(setN)
        .catch(() => setN(null));
    run();
    return subscribe(run);
  }, [load, subscribe]);
  return n;
}

const countDictionary = () => hub.listDictionary("").then((r) => r.length);
const countSnippets = () => hub.listSnippets("").then((r) => r.length);
const countHistory = () => hub.queryHistory({ limit: 1 }).then((r) => r.total);

const plural = (n: number | null, one: string, many: string) =>
  n === null ? "" : `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function LibrarySection({
  settings,
  update,
  navigate,
}: {
  settings: Settings;
  update: Update;
  navigate: (route: string) => void;
}) {
  const save = useSave(update);
  const words = useCount(countDictionary, hub.onLibraryChanged);
  const snippets = useCount(countSnippets, hub.onLibraryChanged);
  const d = settings.dictionary;
  return (
    <>
      <SettingsGroup title="Dictionary">
        <SettingsRow
          label="Use your dictionary"
          htmlFor="dictionary-enabled"
          description="Writes your words exactly as you spell them and fixes spellings Murmur often gets wrong. Turned off, your words are kept but not applied."
          control={
            <Switch
              id="dictionary-enabled"
              label="Use your dictionary"
              describedBy={describedBy("dictionary-enabled")}
              checked={d.enabled}
              onCheckedChange={(v) => void save({ dictionary: { enabled: v } })}
            />
          }
        />
        <SettingsRow
          label="Send words as vocabulary hints"
          htmlFor="dictionary-hints"
          description="Up to 100 words go to your transcription service with each dictation, which helps it recognise names and terms."
          control={
            <Switch
              id="dictionary-hints"
              label="Send words as vocabulary hints"
              describedBy={describedBy("dictionary-hints")}
              checked={d.useAsVocabulary}
              onCheckedChange={(v) =>
                void save({ dictionary: { useAsVocabulary: v } })
              }
            />
          }
        />
        <SettingsRow
          label="Your words"
          description={plural(words, "word", "words")}
          control={
            <Button
              icon={<ArrowUpRight className="size-3.5" aria-hidden />}
              onClick={() => navigate("dictionary")}
            >
              Open Dictionary
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Snippets">
        <SettingsRow
          label="Expand snippets"
          htmlFor="snippets-enabled"
          description="Saying a trigger phrase inserts its saved text. Turned off, snippets are kept but not expanded."
          control={
            <Switch
              id="snippets-enabled"
              label="Expand snippets"
              describedBy={describedBy("snippets-enabled")}
              checked={settings.snippets.enabled}
              onCheckedChange={(v) => void save({ snippets: { enabled: v } })}
            />
          }
        />
        <SettingsRow
          label="Your snippets"
          description={plural(snippets, "snippet", "snippets")}
          control={
            <Button
              icon={<ArrowUpRight className="size-3.5" aria-hidden />}
              onClick={() => navigate("snippets")}
            >
              Open Snippets
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}

/** Whether the Keychain lets Murmur use saved keys and recordings, with a retry (Stage 8). */
function SecureStorageRow() {
  const [info, setInfo] = useState<SecureStorageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  useEffect(() => {
    const load = () =>
      void hub.getStatus().then((s) => setInfo(s.secureStorage ?? null));
    load();
    return hub.onStatusChanged(load);
  }, []);
  if (!info) return null;
  const t = secureStorageText(info);
  return (
    <SettingsGroup>
      <SettingsRow
        label="Secure storage"
        description={t.detail}
        control={
          <>
            <StatusText tone={t.tone} live>
              {t.label}
            </StatusText>
            {info.state === "available" && info.recordings === "unreadable" && (
              <Button onClick={() => setConfirming(true)}>
                Start a new recording key…
              </Button>
            )}
            {t.retry && info.recordings !== "unreadable" && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await hub.retrySecureStorage();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Try again
              </Button>
            )}
          </>
        }
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Start a new recording key?"
        description={
          <>
            Recordings kept for retrying failed dictations are protected by a
            key that can no longer be read. A new key lets Murmur keep them
            again from now on. The old recordings and the old key are moved
            aside, not deleted, and can't be retried. Your History, API keys,
            dictionary and snippets aren't affected.
          </>
        }
        confirmLabel="Start new key"
        onConfirm={async () => {
          const r = await hub.startNewRecordingKey();
          toast({
            title: "New recording key started",
            description: r.archived
              ? `${r.archived} old recording${r.archived === 1 ? "" : "s"} moved aside, not deleted.`
              : "No old recordings needed moving.",
            tone: "success",
          });
        }}
      />
    </SettingsGroup>
  );
}

export function PrivacySection({
  settings,
  update,
}: {
  settings: Settings;
  update: Update;
}) {
  const save = useSave(update);
  const toast = useToast();
  const h = settings.history;
  const dictations = useCount(countHistory, hub.onHistoryChanged);
  const [clearing, setClearing] = useState(false);
  const exportAll = async () => {
    try {
      const r = await hub.exportData();
      if (r.saved)
        toast({ title: "Exported", description: r.path, tone: "success" });
    } catch (e) {
      toast({
        title: "Export failed",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };
  return (
    <>
      <SecureStorageRow />
      {/* The reference shows switches here. Murmur never does these things, so it states that
          instead of offering a switch that couldn't turn on. */}
      <SettingsGroup>
        <SettingsRow
          label="Improve models with your data"
          description="Never. Your audio, transcripts and edits aren't used to train or evaluate any model."
          control={<StatusText tone="neutral">Off</StatusText>}
        />
        <SettingsRow
          label="Cloud storage"
          description="Not used. Murmur has no cloud History: History, recordings, dictionary and snippets are stored only on this Mac."
          control={<StatusText tone="neutral">Off</StatusText>}
        />
      </SettingsGroup>
      <SettingsGroup title="Context">
        <SettingsRow
          label="Context awareness"
          htmlFor="context-awareness"
          description="When you dictate, Murmur reads a little of the text around your cursor (never a password field) to pick out names. The names it finds are sent to your transcription service as spelling hints for that dictation. Nothing is read in terminals, password managers or while a password prompt is open, and nothing it reads is saved or logged. Needs Accessibility access."
          control={
            <Switch
              id="context-awareness"
              label="Context awareness"
              describedBy={describedBy("context-awareness")}
              checked={settings.context.awareness}
              onCheckedChange={(v) => void save({ context: { awareness: v } })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="History">
        <SettingsRow
          label="Keep History on this Mac"
          htmlFor="history-enabled"
          description="Saves what you dictated, so you can find, copy and retry it. Turned off, new dictations aren't saved; existing ones stay until you delete them."
          control={
            <Switch
              id="history-enabled"
              label="Keep History on this Mac"
              describedBy={describedBy("history-enabled")}
              checked={h.enabled}
              onCheckedChange={(v) => void save({ history: { enabled: v } })}
            />
          }
        />
        <SettingsRow
          label="Delete dictations after"
          htmlFor="history-retention"
          description="Older dictations and their recordings are deleted at launch and every 6 hours."
          control={
            <Select
              id="history-retention"
              aria-describedby={describedBy("history-retention")}
              className="w-44"
              value={String(h.historyRetentionDays)}
              onChange={(e) =>
                void save({
                  history: { historyRetentionDays: Number(e.target.value) },
                })
              }
            >
              <option value="0">Never</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </Select>
          }
        />
        <SettingsRow
          label="Keep recordings of failed dictations"
          htmlFor="audio-retention"
          description="So you can retry them. Encrypted (AES-256-GCM) with a key in macOS secure storage, and deleted once a dictation is inserted, unless you keep every recording below."
          control={
            <Select
              id="audio-retention"
              aria-describedby={describedBy("audio-retention")}
              className="w-44"
              value={String(h.audioRetentionDays)}
              onChange={(e) =>
                void save({
                  history: { audioRetentionDays: Number(e.target.value) },
                })
              }
            >
              <option value="0">Don't keep</option>
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </Select>
          }
        />
        <SettingsRow
          label="Keep recordings so I can play them back"
          htmlFor="keep-recordings"
          description={`Each dictation's recording stays on this Mac, encrypted, for ${
            h.audioRetentionDays > 0
              ? `${h.audioRetentionDays} day${h.audioRetentionDays === 1 ? "" : "s"}`
              : "the number of days chosen above (turning this on sets 7)"
          }, then is deleted. Password fields are never kept. Turning this off doesn't delete recordings already kept; they expire as usual.`}
          control={
            <Switch
              id="keep-recordings"
              label="Keep recordings so I can play them back"
              describedBy={describedBy("keep-recordings")}
              checked={h.keepRecordings}
              onCheckedChange={(on) =>
                void save({ history: { keepRecordings: on } })
              }
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Your data">
        <SettingsRow
          label="Export"
          description="History, dictionary, snippets and Notetaker meetings as one JSON file. Recordings aren't included."
          control={
            <Button
              icon={<Download className="size-3.5" aria-hidden />}
              onClick={exportAll}
            >
              Export…
            </Button>
          }
        />
        <SettingsRow
          label="Delete all History"
          description={
            dictations === 0
              ? "History is empty."
              : `${plural(dictations, "dictation", "dictations")} and their recordings. Your dictionary and snippets are kept.`
          }
          control={
            <Button
              variant="danger"
              icon={<Trash2 className="size-3.5" aria-hidden />}
              disabled={!dictations}
              onClick={() => setClearing(true)}
            >
              Delete…
            </Button>
          }
        />
      </SettingsGroup>
      <SettingsGroup
        title="What leaves this Mac"
        description="Based on your current settings."
      >
        {privacyFlows(settings).map((f) => (
          <SettingsRow key={f.label} label={f.label} description={f.value} />
        ))}
      </SettingsGroup>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title="Delete all History?"
        description={`All ${plural(dictations, "dictation", "dictations")} and any encrypted recordings kept for retrying will be deleted from this Mac. Your dictionary and snippets are kept. This can't be undone.`}
        confirmLabel="Delete all"
        destructive
        onConfirm={async () => {
          await hub.clearHistory();
          toast({ title: "History deleted", tone: "success" });
        }}
      />
    </>
  );
}

export function AboutSection({ about }: { about: AppInfo | null }) {
  return (
    <>
      <div className="flex items-center gap-4 rounded-card bg-surface px-5 py-5">
        <MurmurMark className="size-12 shrink-0" />
        <div>
          <div className="font-serif text-empty text-fg">Murmur</div>
          <div className="text-caption text-fg-secondary" data-selectable>
            Version {about?.version ?? "…"}
            {about && !about.packaged && " · development build"}
          </div>
        </div>
      </div>
      <SettingsGroup title="This Mac">
        <SettingsRow
          label="macOS"
          control={<Value>{about && `${about.macOS} (${about.arch})`}</Value>}
        />
        <SettingsRow
          label="Built with"
          control={
            <Value>
              {about &&
                `Electron ${about.electron} · Chromium ${about.chromium}`}
            </Value>
          }
        />
        <SettingsRow
          label="Fonts"
          description="Figtree and EB Garamond, under the SIL Open Font License 1.1 (licence texts ship with the app)."
        />
        <SettingsRow
          label="Data folder"
          description={
            <span className="break-all font-mono" data-selectable>
              {about?.dataPath}
            </span>
          }
          control={
            <Button
              icon={<FolderOpen className="size-3.5" aria-hidden />}
              onClick={() => void hub.revealDataFolder()}
            >
              Show in Finder
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}

function Value({ children }: { children: ReactNode }) {
  return (
    <span className="text-ui text-fg-secondary" data-selectable>
      {children}
    </span>
  );
}
