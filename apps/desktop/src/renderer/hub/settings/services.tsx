// Settings sections for the outside services Murmur can use: Transcription and AI cleanup.
import { LanguageRow } from "./language-dialog.tsx";
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { DictationRow, StatusInfo } from "../../../shared/ipc.ts";
import {
  AI_PROVIDERS,
  SPEECH_PROVIDERS,
  type Settings,
} from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  describedBy,
  InlineAlert,
  SegmentedControl,
  Select,
  SettingsGroup,
  SettingsRow,
} from "../ui/index.ts";
import type { SettingsSectionId } from "../model/settings-sections.ts";
import { friendlyError } from "../model/history.ts";
import { whenLabel } from "../model/home.ts";
import {
  AI_LABELS,
  aiQualityChecked,
  inSettings,
  latestFor,
  providerState,
  SPEECH_LABELS,
} from "../model/settings.ts";
import {
  ApiKeyField,
  CommitInput,
  StatusText,
  useHasKey,
  useSave,
  type Update,
} from "./common.tsx";

/** Recent History rows, for "did it actually work" evidence. Reloads when History changes. */
function useRecentRows(): DictationRow[] {
  const [rows, setRows] = useState<DictationRow[]>([]);
  useEffect(() => {
    const load = () =>
      void hub
        .queryHistory({ limit: 50 })
        .then((r) => setRows(r.rows))
        .catch(() => setRows([]));
    load();
    return hub.onHistoryChanged(load);
  }, []);
  return rows;
}

/** Keeps the stored value selectable even when it isn't one of the offered options. */
function withCurrent(values: number[], current: number) {
  return values.includes(current)
    ? values
    : [...values, current].sort((a, b) => a - b);
}

export function TranscriptionSection({
  settings,
  update,
  status,
  refresh,
  onSection,
}: {
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
  refresh: () => void;
  /** Absent in Onboarding, where there is no Settings sheet to switch section in. */
  onSection?: (s: SettingsSectionId) => void;
}) {
  const save = useSave(update);
  const provider = settings.speech.provider;
  const [keyVersion, setKeyVersion] = useState(0);
  const hasKey = useHasKey(provider, keyVersion);
  const rows = useRecentRows();
  const latest = latestFor(rows, status?.providerId ?? provider);
  const state = status ? providerState(status.providerReady, latest) : null;
  const failure = latest ? friendlyError(latest) : null;
  const label = SPEECH_LABELS[provider];
  const hints =
    settings.dictionary.enabled && settings.dictionary.useAsVocabulary;
  return (
    <>
      <SettingsGroup title="Provider">
        <SettingsRow
          label="Transcription service"
          htmlFor="speech-provider"
          description={
            provider === "whisper.cpp"
              ? "For development: a whisper.cpp server you run yourself. Slower than the cloud services."
              : `The audio of each dictation is sent to ${label} to be transcribed. It isn't stored on any Murmur server.`
          }
          control={
            <Select
              id="speech-provider"
              aria-describedby={describedBy("speech-provider")}
              className="w-48"
              value={provider}
              onChange={(e) =>
                void save({ speech: { provider: e.target.value } })
              }
            >
              {SPEECH_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {SPEECH_LABELS[p]}
                </option>
              ))}
            </Select>
          }
        />
        {provider === "whisper.cpp" ? (
          <SettingsRow
            label="Server address"
            htmlFor="whisper-url"
            description="Murmur sends audio here. Use a localhost address to keep audio on this Mac."
            control={
              <CommitInput
                id="whisper-url"
                value={settings.speech.localServerUrl}
                onCommit={(v) => void save({ speech: { localServerUrl: v } })}
              />
            }
          />
        ) : (
          <SettingsRow
            label="API key"
            htmlFor="speech-key"
            description={
              hasKey
                ? `Saved and encrypted by macOS. Murmur never shows it again.${
                    settings.cleanup.aiProvider === provider
                      ? " AI cleanup uses the same key."
                      : ""
                  }`
                : `Not set. Create one in your ${label} account.`
            }
            control={
              <ApiKeyField
                id="speech-key"
                provider={provider}
                providerLabel={label}
                hasKey={hasKey}
                onChanged={() => {
                  setKeyVersion((v) => v + 1);
                  refresh();
                }}
              />
            }
          />
        )}
        <SettingsRow
          label="Status"
          description={
            state?.detail ??
            (latest &&
              (failure
                ? `${whenLabel(latest.startedAt, new Date())}: ${failure.summary}`
                : `${whenLabel(latest.startedAt, new Date())}, in ${latest.appName ?? "an app"}.`))
          }
          control={
            state && (
              <StatusText tone={state.tone} live>
                {state.label}
              </StatusText>
            )
          }
        />
      </SettingsGroup>
      <SettingsGroup title="Recognition">
        <LanguageRow settings={settings} update={update} />
        <SettingsRow
          label="Model"
          htmlFor="speech-model"
          description="Leave empty to use the service's default model."
          control={
            <CommitInput
              id="speech-model"
              value={settings.speech.model}
              placeholder="Service default"
              className="w-52"
              onCommit={(v) => void save({ speech: { model: v } })}
            />
          }
        />
        <SettingsRow
          label="Time limit"
          htmlFor="speech-timeout"
          description="How long to wait for a transcript. If it takes longer, the recording is kept so you can retry from History."
          control={
            <Select
              id="speech-timeout"
              aria-describedby={describedBy("speech-timeout")}
              className="w-40"
              value={String(settings.speech.timeoutMs)}
              onChange={(e) =>
                void save({ speech: { timeoutMs: Number(e.target.value) } })
              }
            >
              {withCurrent(
                [15000, 30000, 60000, 120000],
                settings.speech.timeoutMs,
              ).map((ms) => (
                <option key={ms} value={String(ms)}>
                  {ms / 1000} seconds
                </option>
              ))}
            </Select>
          }
        />
        <SettingsRow
          label="When text appears"
          description="Each dictation is transcribed in one piece after you release the shortcut. Live, word-by-word transcription isn't available in this version."
        />
        <SettingsRow
          label="Vocabulary hints"
          description={
            hints
              ? "On: up to 100 dictionary words are sent with each dictation to help with names and terms."
              : "Off: dictionary words aren't sent to the transcription service."
          }
          control={
            onSection && (
              <Button onClick={() => onSection("library")}>Change…</Button>
            )
          }
        />
      </SettingsGroup>
    </>
  );
}

const MODE_HELP: Record<Settings["cleanup"]["mode"], string> = {
  deterministic:
    "Removes filler words and applies spoken punctuation and capitals, on this Mac. Never changes what you meant.",
  ai: "Also fixes repeated words, self-corrections and paragraphs. Each result is checked, and Light cleanup is used if it looks wrong or arrives late.",
  off: "Inserts exactly what was transcribed. Your dictionary and snippets still apply.",
};

/** The last dictation that went through AI cleanup, and how it ended. */
function lastAiOutcome(rows: DictationRow[]): string | null {
  const r = rows.find(
    (x) => x.cleanupUsed === "ai" || x.cleanupNote?.startsWith("ai-fallback:"),
  );
  if (!r) return null;
  const when = whenLabel(r.startedAt, new Date());
  return r.cleanupUsed === "ai"
    ? `${when}: AI cleanup was used.`
    : `${when}: fell back to Light cleanup (${r.cleanupNote!.slice(12).replace(/-/g, " ")}).`;
}

export function AiSection({
  settings,
  update,
}: {
  settings: Settings;
  update: Update;
}) {
  const save = useSave(update);
  const c = settings.cleanup;
  const [keyVersion, setKeyVersion] = useState(0);
  const hasKey = useHasKey(c.aiProvider, keyVersion);
  const [ready, setReady] = useState<string | null | undefined>(undefined);
  const refreshAi = useCallback(
    () =>
      void hub
        .aiCleanupStatus()
        .then((s) => setReady(s.ready))
        .catch(() => setReady(undefined)),
    [],
  );
  useEffect(refreshAi, [refreshAi, c.aiProvider, c.aiModel, keyVersion]);
  const rows = useRecentRows();
  const outcome = lastAiOutcome(rows);
  const label = AI_LABELS[c.aiProvider];
  return (
    <>
      <SettingsGroup title="Cleanup">
        <SettingsRow
          label="Mode"
          describes="cleanup-mode"
          description={MODE_HELP[c.mode]}
          control={
            <SegmentedControl
              label="Cleanup mode"
              describedBy={describedBy("cleanup-mode")}
              value={c.mode}
              onChange={(v) => void save({ cleanup: { mode: v } })}
              options={[
                { value: "off", label: "None" },
                { value: "deterministic", label: "Light" },
                { value: "ai", label: "Medium" },
              ]}
            />
          }
        />
      </SettingsGroup>
      {c.mode === "ai" && (
        <>
          <InlineAlert tone="warning" icon={<ShieldAlert />}>
            <strong className="font-semibold">
              {aiQualityChecked(c.aiProvider, c.aiModel)
                ? "Passed Murmur's quality check."
                : "This model hasn't been quality-checked."}
            </strong>{" "}
            With AI cleanup on, the transcript of every dictation is sent to{" "}
            {label}. Murmur treats it as text to tidy, never as instructions,
            and checks every result.
          </InlineAlert>
          <SettingsGroup title="AI service">
            <SettingsRow
              label="Service"
              htmlFor="ai-provider"
              control={
                <Select
                  id="ai-provider"
                  className="w-52"
                  value={c.aiProvider}
                  onChange={(e) =>
                    void save({ cleanup: { aiProvider: e.target.value } })
                  }
                >
                  {AI_PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {AI_LABELS[p]}
                    </option>
                  ))}
                </Select>
              }
            />
            <SettingsRow
              label="API key"
              htmlFor="ai-key"
              description={
                hasKey
                  ? `Saved and encrypted by macOS.${
                      settings.speech.provider === c.aiProvider
                        ? " Transcription uses the same key."
                        : ""
                    }`
                  : `Not set. Create one in your ${label} account.`
              }
              control={
                <ApiKeyField
                  id="ai-key"
                  provider={c.aiProvider}
                  providerLabel={label}
                  hasKey={hasKey}
                  onChanged={() => setKeyVersion((v) => v + 1)}
                />
              }
            />
            <SettingsRow
              label="Model"
              htmlFor="ai-model"
              description="Leave empty for Murmur's default for this service."
              control={
                <CommitInput
                  id="ai-model"
                  value={c.aiModel}
                  placeholder="Default"
                  className="w-52"
                  onCommit={(v) => void save({ cleanup: { aiModel: v } })}
                />
              }
            />
            <SettingsRow
              label="Time limit"
              htmlFor="ai-timeout"
              description="If the AI doesn't answer in time, Light cleanup is used."
              control={
                <Select
                  id="ai-timeout"
                  aria-describedby={describedBy("ai-timeout")}
                  className="w-40"
                  value={String(c.aiTimeoutMs)}
                  onChange={(e) =>
                    void save({
                      cleanup: { aiTimeoutMs: Number(e.target.value) },
                    })
                  }
                >
                  {withCurrent([2000, 4000, 8000, 15000], c.aiTimeoutMs).map(
                    (ms) => (
                      <option key={ms} value={String(ms)}>
                        {ms / 1000} seconds
                      </option>
                    ),
                  )}
                </Select>
              }
            />
            <SettingsRow
              label="Status"
              description={
                (ready && inSettings(ready, AI_LABELS)) ??
                outcome ??
                "The key is saved. Murmur checks the service when you dictate."
              }
              control={
                ready !== undefined && (
                  <StatusText tone={ready ? "danger" : "neutral"} live>
                    {ready ? "Not set up" : "Ready"}
                  </StatusText>
                )
              }
            />
          </SettingsGroup>
        </>
      )}
    </>
  );
}
