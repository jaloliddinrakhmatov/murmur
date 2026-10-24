// Building blocks shared by the Settings sections.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { hub } from "../bridge.ts";
import {
  Button,
  ConfirmDialog,
  describedBy,
  Input,
  StatusDot,
  useToast,
  type Tone,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";

export type Update = (patch: unknown) => Promise<void>;

/**
 * Saves a settings patch and reports a rejected one in a toast. The main process validates every
 * patch and keeps the last valid settings when it refuses one, so nothing else changes.
 */
export function useSave(update: Update) {
  const toast = useToast();
  return useCallback(
    async (patch: unknown): Promise<boolean> => {
      try {
        await update(patch);
        return true;
      } catch (e) {
        toast({
          title: "Couldn't save that setting",
          description: ipcErrorMessage(e),
          tone: "error",
        });
        return false;
      }
    },
    [update, toast],
  );
}

/** A text setting saved when the field loses focus or on Enter (Esc restores the saved value). */
export function CommitInput({
  id,
  value,
  onCommit,
  placeholder,
  className = "w-56",
  ariaLabel,
}: {
  id: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      id={id}
      aria-describedby={describedBy(id)}
      aria-label={ariaLabel}
      className={className}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape" && draft !== value) {
          e.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

/** Status text with a dot; `live` announces changes to screen readers. */
export function StatusText({
  tone,
  children,
  live,
}: {
  tone: Tone;
  children: ReactNode;
  live?: boolean;
}) {
  return (
    <span
      className="inline-flex items-center"
      aria-live={live ? "polite" : undefined}
    >
      <StatusDot tone={tone} label={children} />
    </span>
  );
}

/**
 * API key for a provider. The key is stored encrypted by macOS and never sent back to this
 * window: the row only learns whether one exists.
 */
export function ApiKeyField({
  id,
  provider,
  providerLabel,
  hasKey,
  onChanged,
}: {
  id: string;
  provider: string;
  providerLabel: string;
  hasKey: boolean | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => setDraft(""), [provider]);

  const save = async () => {
    setBusy(true);
    try {
      await hub.setSecret(provider, draft.trim());
      setDraft("");
      toast({ title: `${providerLabel} API key saved`, tone: "success" });
      onChanged();
    } catch (e) {
      toast({
        title: "Couldn't save the key",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) void save();
        }}
      >
        <Input
          id={id}
          type="password"
          aria-describedby={describedBy(id)}
          className="w-52"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            hasKey ? "Paste a new key to replace" : "Paste your API key"
          }
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!draft.trim()}
          loading={busy}
        >
          Save
        </Button>
        {hasKey && <Button onClick={() => setRemoving(true)}>Remove</Button>}
      </form>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove the ${providerLabel} API key?`}
        description="Murmur will stop using this provider until you add a key again."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          await hub.setSecret(provider, "");
          toast({ title: `${providerLabel} API key removed` });
          onChanged();
        }}
      />
    </>
  );
}

/** Whether a key is stored for `provider`; bump `version` after saving or removing one. */
export function useHasKey(provider: string, version: unknown) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(
    () =>
      void hub
        .hasSecret(provider)
        .then(setHasKey)
        .catch(() => setHasKey(null)),
    [provider, version],
  );
  return hasKey;
}
