// Dictation language (reference: Settings → General → Dictation Languages “Change”). Murmur
// sends one language with each dictation, or none for automatic detection, so this is a single
// choice: the reference's multi-select becomes one selected tile. Only languages the current
// transcription service accepts are listed. Nothing is saved until “Save and close”.
import { useEffect, useRef, useState } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { Minus, Search, X } from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import {
  Button,
  cn,
  describedBy,
  Dialog,
  DialogContent,
  DialogFooter,
  SettingsRow,
  Switch,
} from "../ui/index.ts";
import { moveSelection } from "../ui/roving.ts";
import {
  filterLanguages,
  languageName,
  languagesFor,
  languageUnsupported,
  LANGUAGES,
} from "../model/languages.ts";
import { SPEECH_LABELS } from "../model/settings.ts";
import { useSave, type Update } from "./common.tsx";

export function LanguageDialog({
  open,
  onOpenChange,
  settings,
  update,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  update: Update;
}) {
  const save = useSave(update);
  const provider = settings.speech.provider;
  const stored = settings.speech.language;
  const [draft, setDraft] = useState(stored);
  const [query, setQuery] = useState("");
  const lastChoice = useRef(stored || "en");
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (open) {
      setDraft(stored);
      setQuery("");
      lastChoice.current = stored || lastChoice.current;
    }
  }, [open, stored]);

  const all = languagesFor(provider);
  const shown = filterLanguages(all, query);
  const choose = (code: string) => {
    setDraft(code);
    if (code) lastChoice.current = code;
  };
  const service = SPEECH_LABELS[provider];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(570px,calc(100vh-48px))] w-[min(852px,calc(100vw-48px))]">
        <div className="mb-5 flex shrink-0 items-start gap-6">
          <div className="min-w-0 flex-1 space-y-1">
            <RadixDialog.Title className="text-heading font-semibold text-fg">
              Dictation language
            </RadixDialog.Title>
            <RadixDialog.Description className="max-w-[520px] text-ui text-fg-secondary">
              Choose the language you dictate in. Murmur sends it to {service}{" "}
              with each dictation, one language at a time.
            </RadixDialog.Description>
          </div>
          <label className="mt-1 flex shrink-0 items-center gap-3 text-ui font-semibold text-fg">
            Detect automatically
            <Switch
              label="Detect automatically"
              checked={draft === ""}
              onCheckedChange={(on) =>
                choose(on ? "" : lastChoice.current || LANGUAGES[0].code)
              }
            />
          </label>
          <RadixDialog.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="-mr-2 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-md text-fg hover:bg-surface-hover"
            >
              <X className="size-4" aria-hidden />
            </button>
          </RadixDialog.Close>
        </div>
        <div className="flex min-h-0 flex-1 gap-5 max-[760px]:flex-col">
          <div className="flex min-h-0 min-w-0 flex-[0_1_560px] flex-col overflow-hidden rounded-xl border border-hairline">
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-3">
              <Search className="size-4 text-fg-secondary" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search languages"
                aria-label="Search languages"
                className="no-drag h-full min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-tertiary [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {shown.length === 0 ? (
                <p className="px-1 py-6 text-center text-ui text-fg-secondary">
                  No {service} languages match “{query.trim()}”.
                </p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Language"
                  className="grid grid-cols-3 gap-3 max-[760px]:grid-cols-2"
                >
                  {shown.map((l, i) => {
                    const active = l.code === draft;
                    const focusable =
                      active ||
                      (!shown.some((x) => x.code === draft) && i === 0);
                    return (
                      <button
                        key={l.code}
                        ref={(el) => {
                          tiles.current[i] = el;
                        }}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        tabIndex={focusable ? 0 : -1}
                        onClick={() => choose(l.code)}
                        onKeyDown={(e) =>
                          moveSelection(
                            e,
                            i,
                            shown.map((x) => x.code),
                            choose,
                            tiles,
                          )
                        }
                        className={cn(
                          "no-drag flex min-h-[54px] flex-col justify-center rounded-md px-3 py-1.5 text-left transition-shadow duration-[var(--m-duration-fast)]",
                          active
                            ? "bg-accent-faint shadow-[inset_0_0_0_1.5px_var(--m-accent)]"
                            : "bg-surface hover:bg-surface-hover",
                        )}
                      >
                        <span className="text-ui font-semibold text-fg">
                          {l.name}
                        </span>
                        {l.native !== l.name && (
                          <span className="text-caption text-fg-secondary">
                            {l.native}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <section
            aria-labelledby="language-selected"
            className="flex min-w-0 flex-1 flex-col"
          >
            <h3
              id="language-selected"
              className="text-ui font-semibold text-fg"
            >
              Selected
            </h3>
            <div className="mt-4 flex items-center gap-2 text-ui text-fg">
              <span className="min-w-0 flex-1" aria-live="polite">
                {languageName(draft)}
              </span>
              {draft && (
                <button
                  type="button"
                  aria-label={`Remove ${languageName(draft)} and detect automatically`}
                  onClick={() => choose("")}
                  className="no-drag flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-hover hover:text-fg"
                >
                  <Minus className="size-4" aria-hidden />
                </button>
              )}
            </div>
            {languageUnsupported(draft, provider) && (
              <p role="alert" className="mt-2 text-caption text-danger">
                {service} doesn't accept {languageName(draft)}. Choose another
                language or detect automatically.
              </p>
            )}
            <p className="mt-2 text-caption text-fg-secondary">
              {draft
                ? "Every dictation is transcribed as this language."
                : `${service} works out the language of each dictation.`}
            </p>
            <div className="mt-auto">
              <DialogFooter>
                <Button
                  variant="primary"
                  disabled={languageUnsupported(draft, provider)}
                  onClick={async () => {
                    if (await save({ speech: { language: draft } }))
                      onOpenChange(false);
                  }}
                >
                  Save and close
                </Button>
              </DialogFooter>
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The “Dictation language” row: current choice and a Change button for the dialog. The sheet
 * controls the dialog (deep links open it); elsewhere (Onboarding) the row keeps its own state.
 */
export function LanguageRow({
  settings,
  update,
  open,
  onOpenChange,
}: {
  settings: Settings;
  update: Update;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [local, setLocal] = useState(false);
  const isOpen = open ?? local;
  const setOpen = onOpenChange ?? setLocal;
  const code = settings.speech.language;
  const provider = settings.speech.provider;
  return (
    <>
      <SettingsRow
        label="Dictation language"
        describes="speech-language"
        description={
          languageUnsupported(code, provider) ? (
            <span className="text-danger">
              {languageName(code)} isn't accepted by {SPEECH_LABELS[provider]}.
              Choose another language.
            </span>
          ) : (
            languageName(code)
          )
        }
        control={
          <Button
            id="speech-language"
            variant="secondary"
            className="w-[164px]"
            aria-describedby={describedBy("speech-language")}
            onClick={() => setOpen(true)}
          >
            Change
          </Button>
        }
      />
      <LanguageDialog
        open={isOpen}
        onOpenChange={setOpen}
        settings={settings}
        update={update}
      />
    </>
  );
}
