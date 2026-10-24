// Dictionary: words Murmur should always spell your way, each optionally replacing a spelling it
// often mishears. Rows are kept in local SQLite; this screen lists, searches and edits them.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookA,
  Download,
  MoreHorizontal,
  Plus,
  PowerOff,
  SearchX,
  Upload,
} from "lucide-react";
import type { DictionaryRow } from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  cn,
  EditorDialog,
  EmptyState,
  Field,
  IconButton,
  InlineAlert,
  Input,
  ListRow,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  ConfirmDialog,
  Switch,
  useToast,
  Banner,
  type SearchToggleHandle,
  SortMenu,
  useStoredChoice,
} from "../ui/index.ts";
import { PageHeader } from "../shell/shell.tsx";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  countLabel,
  filterDictionary,
  sortLibrary,
  SORT_ORDERS,
  type SortOrder,
  PHRASE_MAX,
  PHRASE_MIN,
  validateDictionary,
} from "../model/library.ts";
import {
  ListNote,
  ListPanel,
  ListSkeleton,
  LibraryToolbar,
  LoadError,
  RowActions,
  useLibraryList,
  useDismissed,
} from "./library.tsx";

type Editor =
  { mode: "add"; phrase?: string } | { mode: "edit"; row: DictionaryRow };

const fetchDictionary = () => hub.listDictionary("");

export function DictionaryPage({
  settings,
  update,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
}) {
  const toast = useToast();
  const { rows, setRows, error, reload } = useLibraryList(fetchDictionary);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<DictionaryRow | null>(null);
  const searchRef = useRef<SearchToggleHandle>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes after a delete; decided before the list reloads. */
  const afterDeleteRef = useRef<"search" | "add" | null>(null);
  const [order, setOrder] = useStoredChoice<SortOrder>(
    "murmur.sort.dictionary",
    SORT_ORDERS.map((o) => o.id),
    "newest",
  );
  const shown = useMemo(
    () =>
      sortLibrary(filterDictionary(rows ?? [], query), order, (r) => r.phrase),
    [rows, query, order],
  );

  const setEnabled = async (row: DictionaryRow, enabled: boolean) => {
    setRows(
      (list) =>
        list?.map((r) => (r.id === row.id ? { ...r, enabled } : r)) ?? null,
    );
    try {
      await hub.updateDictionaryEntry(row.id, { enabled });
    } catch (e) {
      toast({
        title: `Couldn't update “${row.phrase}”`,
        description: ipcErrorMessage(e),
        tone: "error",
      });
      void reload();
    }
  };
  const importWords = async () => {
    try {
      const r = await hub.importDictionary();
      if (r.cancelled) return;
      toast({
        title: `Imported ${r.added} word${r.added === 1 ? "" : "s"}`,
        description: r.skipped
          ? `Skipped ${r.skipped} duplicate or invalid entr${r.skipped === 1 ? "y" : "ies"}.`
          : undefined,
        tone: "success",
      });
    } catch (e) {
      toast({
        title: "Import failed",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };
  const exportWords = async () => {
    try {
      const r = await hub.exportDictionary();
      if (r.saved)
        toast({
          title: "Dictionary exported",
          description: r.path,
          tone: "success",
        });
    } catch (e) {
      toast({
        title: "Export failed",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  const [bannerDismissed, dismissBanner] = useDismissed("dictionary");
  const q = query.trim();
  const total = rows?.length ?? 0;
  return (
    <div>
      <PageHeader
        title="Dictionary"
        actions={
          <Button
            ref={addRef}
            variant="primary"
            onClick={() => setEditor({ mode: "add" })}
          >
            Add word
          </Button>
        }
      />
      {!settings.dictionary.enabled && (
        <div className="mb-4">
          <InlineAlert
            tone="warning"
            icon={<PowerOff />}
            action={
              <Button
                size="sm"
                onClick={() => update({ dictionary: { enabled: true } })}
              >
                Turn on
              </Button>
            }
          >
            The dictionary is off. Your words are kept but not applied to
            dictations.
          </InlineAlert>
        </div>
      )}

      {error ? (
        <LoadError message={error} what="dictionary" onRetry={reload} />
      ) : rows === null ? (
        <ListSkeleton />
      ) : total === 0 ? (
        <section aria-label="No words" className="rounded-lg bg-surface">
          <EmptyState
            icon={<BookA className="size-5" aria-hidden />}
            title="No custom words yet"
            description="Add names, product terms and acronyms. Murmur writes them exactly as you spell them and can fix a spelling it often gets wrong."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => setEditor({ mode: "add" })}
                >
                  Add word
                </Button>
                <Button onClick={importWords}>Import…</Button>
              </div>
            }
          />
        </section>
      ) : (
        <>
          <LibraryToolbar
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            placeholder="Search words"
            label="Search dictionary"
            count={countLabel(shown.length, total, ["word", "words"])}
            sort={
              <SortMenu
                label="Sort words"
                options={SORT_ORDERS}
                value={order}
                onChange={setOrder}
              />
            }
            extra={
              <Menu>
                <MenuTrigger asChild>
                  <IconButton
                    label="More dictionary actions"
                    icon={<MoreHorizontal className="size-4" aria-hidden />}
                  />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem
                    icon={<Download className="size-3.5" />}
                    onSelect={importWords}
                  >
                    Import words…
                  </MenuItem>
                  <MenuItem
                    icon={<Upload className="size-3.5" />}
                    onSelect={exportWords}
                  >
                    Export words…
                  </MenuItem>
                </MenuContent>
              </Menu>
            }
          />
          {!bannerDismissed && (
            <Banner
              scene="dictionary"
              title={
                <>
                  Spelled <em className="italic">your</em> way, every time.
                </>
              }
              onDismiss={dismissBanner}
              className="mb-9"
              actions={
                <Button
                  variant="banner"
                  onClick={() => setEditor({ mode: "add" })}
                >
                  Add new word
                </Button>
              }
            >
              <p>
                Add names, product terms and jargon once. Murmur writes them
                exactly as you spell them in every dictation, and can fix a
                spelling it often gets wrong.
              </p>
            </Banner>
          )}
          {shown.length === 0 ? (
            <section aria-label="No results" className="rounded-lg bg-surface">
              <EmptyState
                icon={<SearchX className="size-5" aria-hidden />}
                title={`No words match “${q}”`}
                description="Search looks at each word and the spelling it replaces."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {q.length >= PHRASE_MIN && q.length <= PHRASE_MAX && (
                      <Button
                        variant="primary"
                        onClick={() => setEditor({ mode: "add", phrase: q })}
                      >
                        Add “{q}”
                      </Button>
                    )}
                    <Button
                      onClick={() => {
                        setQuery("");
                        searchRef.current?.focus();
                      }}
                    >
                      Clear search
                    </Button>
                  </div>
                }
              />
            </section>
          ) : (
            <ListPanel label="Dictionary words">
              {shown.map((row) => (
                <li key={row.id}>
                  <ListRow
                    onClick={() => setEditor({ mode: "edit", row })}
                    title={
                      <span className={cn(!row.enabled && "text-fg-tertiary")}>
                        {row.misheardAs ? (
                          <>
                            {row.misheardAs} <span aria-label="becomes">→</span>{" "}
                            {row.phrase}
                          </>
                        ) : (
                          row.phrase
                        )}
                      </span>
                    }
                    actions={
                      <RowActions
                        name={row.phrase}
                        onEdit={() => setEditor({ mode: "edit", row })}
                        onDelete={() => setDeleting(row)}
                      />
                    }
                    trailing={
                      <span className="flex items-center gap-3">
                        {rowNote(row) && (
                          <span className="text-caption text-fg-secondary">
                            {rowNote(row)}
                          </span>
                        )}
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(v) => void setEnabled(row, v)}
                          label={`Apply ${row.phrase}`}
                        />
                      </span>
                    }
                  />
                </li>
              ))}
            </ListPanel>
          )}
          <ListNote>
            {settings.dictionary.useAsVocabulary
              ? "Words are matched as whole words, never inside links, emails or file paths. The first 100 are also sent to your transcription provider as vocabulary hints."
              : "Words are matched as whole words, never inside links, emails or file paths. Vocabulary hints to the transcription provider are off in Settings."}
          </ListNote>
        </>
      )}

      {editor && (
        <DictionaryEditor
          key={editor.mode === "edit" ? editor.row.id : "add"}
          editor={editor}
          onClose={() => setEditor(null)}
          onSaved={(row, created) =>
            toast({
              title: created
                ? `Added “${row.phrase}”`
                : `Saved “${row.phrase}”`,
              tone: "success",
            })
          }
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.phrase ?? ""}”?`}
        description="Murmur will stop enforcing this spelling. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await hub.deleteDictionaryEntry(deleting.id);
          afterDeleteRef.current = total > 1 ? "search" : "add";
          toast({ title: `Deleted “${deleting.phrase}”`, tone: "success" });
        }}
        onCloseAutoFocus={(e) => {
          // The row (and its Delete button) is gone: continue from search, or from "Add word"
          // when that was the last word.
          const target = afterDeleteRef.current;
          if (target) {
            afterDeleteRef.current = null;
            e.preventDefault();
            (target === "search" ? searchRef : addRef).current?.focus();
          }
        }}
      />
    </div>
  );
}

/** Right-hand note: real usage from SQLite, or that the word is switched off. */
function rowNote(row: DictionaryRow): string | null {
  if (!row.enabled) return "Off";
  return row.usageCount > 0 ? `Used ${row.usageCount.toLocaleString()}×` : null;
}

function DictionaryEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor;
  onClose: () => void;
  onSaved: (row: DictionaryRow, created: boolean) => void;
}) {
  const editing = editor.mode === "edit" ? editor.row : null;
  const initial = {
    phrase:
      editing?.phrase ?? (editor.mode === "add" ? (editor.phrase ?? "") : ""),
    misheardAs: editing?.misheardAs ?? "",
  };
  const [phrase, setPhrase] = useState(initial.phrase);
  const [misheardAs, setMisheardAs] = useState(initial.misheardAs);
  const [touched, setTouched] = useState(Boolean(initial.phrase));
  const [duplicate, setDuplicate] = useState<DictionaryRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phraseRef = useRef<HTMLInputElement>(null);

  // Duplicate check by the main process, with the repository's own matching rules.
  useEffect(() => {
    const p = phrase.trim();
    if (p.length < PHRASE_MIN) {
      setDuplicate(null);
      return;
    }
    let current = true;
    const t = setTimeout(
      () =>
        void hub
          .findDictionaryPhrase(p)
          .then((d) => current && setDuplicate(d))
          .catch(() => current && setDuplicate(null)),
      120,
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [phrase]);

  const v = validateDictionary(
    { phrase, misheardAs },
    { editingId: editing?.id ?? null, duplicate, showRequired: touched },
  );
  const dirty = phrase !== initial.phrase || misheardAs !== initial.misheardAs;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const entry = {
        phrase: phrase.trim(),
        misheardAs: misheardAs.trim() || null,
      };
      const row = editing
        ? await hub.updateDictionaryEntry(editing.id, entry)
        : await hub.addDictionaryEntry(entry);
      if (!row) throw new Error("This word no longer exists.");
      onSaved(row, !editing);
      onClose();
    } catch (e) {
      setError(ipcErrorMessage(e));
      setSaving(false);
    }
  };

  return (
    <EditorDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={editing ? "Edit word" : "Add word"}
      description="Murmur writes it exactly like this in every dictation."
      dirty={dirty}
      canSave={v.canSave && (dirty || !editing)}
      saving={saving}
      saveLabel={editing ? "Save" : "Add word"}
      error={error}
      onSubmit={save}
      onInvalidSubmit={() => setTouched(true)}
      initialFocus={phraseRef}
    >
      <div className="space-y-4">
        <Field
          label="Word or phrase"
          hint="Spelled and capitalized as it should appear, e.g. NestJS or Bill of Lading."
          error={v.phrase}
        >
          {({ id, describedBy }) => (
            <Input
              ref={phraseRef}
              id={id}
              aria-describedby={describedBy}
              aria-invalid={Boolean(v.phrase)}
              value={phrase}
              maxLength={PHRASE_MAX}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPhrase(e.target.value)}
              onBlur={() => phrase && setTouched(true)}
            />
          )}
        </Field>
        <Field
          label="Often heard as (optional)"
          hint="A wrong spelling to replace with this word, e.g. “nest js”."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={misheardAs}
              maxLength={PHRASE_MAX}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setMisheardAs(e.target.value)}
            />
          )}
        </Field>
      </div>
    </EditorDialog>
  );
}
