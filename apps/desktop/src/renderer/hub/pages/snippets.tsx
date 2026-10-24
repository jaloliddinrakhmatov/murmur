// Snippets: say a trigger phrase, get the saved text. Rows are kept in local SQLite; expansion
// itself (whole words, case-insensitive, longest trigger wins, single pass) lives in @murmur/text.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Plus, PowerOff, Quote, SearchX } from "lucide-react";
import type { SnippetIssue, SnippetRow } from "../../../shared/ipc.ts";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  cn,
  ConfirmDialog,
  EditorDialog,
  EmptyState,
  Field,
  InlineAlert,
  Input,
  ListRow,
  Switch,
  Textarea,
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
  filterSnippets,
  sortLibrary,
  SORT_ORDERS,
  type SortOrder,
  oneLine,
  REPLACEMENT_MAX,
  TRIGGER_MAX,
  validateSnippet,
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

type Editor = { mode: "create" } | { mode: "edit"; row: SnippetRow };

const fetchSnippets = () => hub.listSnippets("");

export function SnippetsPage({
  settings,
  update,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
}) {
  const toast = useToast();
  const { rows, setRows, error, reload } = useLibraryList(fetchSnippets);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [deleting, setDeleting] = useState<SnippetRow | null>(null);
  const searchRef = useRef<SearchToggleHandle>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes after a delete; decided before the list reloads. */
  const afterDeleteRef = useRef<"search" | "create" | null>(null);
  const [order, setOrder] = useStoredChoice<SortOrder>(
    "murmur.sort.snippets",
    SORT_ORDERS.map((o) => o.id),
    "newest",
  );
  const shown = useMemo(
    () =>
      sortLibrary(filterSnippets(rows ?? [], query), order, (r) => r.trigger),
    [rows, query, order],
  );

  const setEnabled = async (row: SnippetRow, enabled: boolean) => {
    setRows(
      (list) =>
        list?.map((r) => (r.id === row.id ? { ...r, enabled } : r)) ?? null,
    );
    try {
      await hub.updateSnippet(row.id, { enabled });
    } catch (e) {
      toast({
        title: `Couldn't update “${row.trigger}”`,
        description: ipcErrorMessage(e),
        tone: "error",
      });
      void reload();
    }
  };

  const [bannerDismissed, dismissBanner] = useDismissed("snippets");
  const q = query.trim();
  const total = rows?.length ?? 0;
  return (
    <div>
      <PageHeader
        title="Snippets"
        actions={
          <Button
            ref={createRef}
            variant="primary"
            onClick={() => setEditor({ mode: "create" })}
          >
            Create snippet
          </Button>
        }
      />
      {!settings.snippets.enabled && (
        <div className="mb-4">
          <InlineAlert
            tone="warning"
            icon={<PowerOff />}
            action={
              <Button
                size="sm"
                onClick={() => update({ snippets: { enabled: true } })}
              >
                Turn on
              </Button>
            }
          >
            Snippets are off. Triggers are kept but not expanded in dictations.
          </InlineAlert>
        </div>
      )}

      {error ? (
        <LoadError message={error} what="snippets" onRetry={reload} />
      ) : rows === null ? (
        <ListSkeleton />
      ) : total === 0 ? (
        <section aria-label="No snippets" className="rounded-lg bg-surface">
          <EmptyState
            icon={<Quote className="size-5" aria-hidden />}
            title="Create your first snippet"
            description="Say a short trigger phrase like “my email” and Murmur inserts the saved text instead: an address, a sign-off, a template."
            action={
              <Button
                variant="primary"
                onClick={() => setEditor({ mode: "create" })}
              >
                Create snippet
              </Button>
            }
          />
        </section>
      ) : (
        <>
          <LibraryToolbar
            query={query}
            onQuery={setQuery}
            searchRef={searchRef}
            placeholder="Search snippets"
            label="Search snippets"
            count={countLabel(shown.length, total, ["snippet", "snippets"])}
            sort={
              <SortMenu
                label="Sort snippets"
                options={SORT_ORDERS}
                value={order}
                onChange={setOrder}
              />
            }
          />
          {!bannerDismissed && (
            <Banner
              scene="snippets"
              title={
                <>
                  Say a phrase, get <em className="italic">the whole</em> text.
                </>
              }
              onDismiss={dismissBanner}
              className="mb-9"
              actions={
                <Button
                  variant="banner"
                  onClick={() => setEditor({ mode: "create" })}
                >
                  Add new snippet
                </Button>
              }
            >
              <p>
                Save text you type often — an address, a sign-off, a prompt —
                then say its trigger phrase to insert it.
              </p>
            </Banner>
          )}
          {shown.length === 0 ? (
            <section aria-label="No results" className="rounded-lg bg-surface">
              <EmptyState
                icon={<SearchX className="size-5" aria-hidden />}
                title={`No snippets match “${q}”`}
                description="Search looks at trigger phrases and the text they insert."
                action={
                  <Button
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                  >
                    Clear search
                  </Button>
                }
              />
            </section>
          ) : (
            <ListPanel label="Snippets">
              {shown.map((row) => (
                <li key={row.id}>
                  <ListRow
                    onClick={() => setEditor({ mode: "edit", row })}
                    title={
                      <span className={cn(!row.enabled && "text-fg-tertiary")}>
                        {row.trigger} <span aria-label="inserts">→</span>{" "}
                        {/* The whole row stays within the 160-character preview. */}
                        {oneLine(
                          row.replacement,
                          Math.max(40, 157 - row.trigger.length),
                        )}
                      </span>
                    }
                    actions={
                      <RowActions
                        name={`snippet ${row.trigger}`}
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
                          label={`Use snippet ${row.trigger}`}
                        />
                      </span>
                    }
                  />
                </li>
              ))}
            </ListPanel>
          )}
          <ListNote>
            Triggers match whole words and ignore capitalization. When two
            triggers match, the longer one wins, and inserted text is never
            expanded again.
          </ListNote>
        </>
      )}

      {editor && (
        <SnippetEditor
          key={editor.mode === "edit" ? editor.row.id : "create"}
          editor={editor}
          onClose={() => setEditor(null)}
          onSaved={(row, created) =>
            toast({
              title: created
                ? `Created “${row.trigger}”`
                : `Saved “${row.trigger}”`,
              tone: "success",
            })
          }
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.trigger ?? ""}”?`}
        description="Saying this phrase will no longer insert its text. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await hub.deleteSnippet(deleting.id);
          afterDeleteRef.current = total > 1 ? "search" : "create";
          toast({ title: `Deleted “${deleting.trigger}”`, tone: "success" });
        }}
        onCloseAutoFocus={(e) => {
          const target = afterDeleteRef.current;
          if (target) {
            afterDeleteRef.current = null;
            e.preventDefault();
            (target === "search" ? searchRef : createRef).current?.focus();
          }
        }}
      />
    </div>
  );
}

/** Right-hand note: real usage from SQLite, or that the snippet is switched off. */
function rowNote(row: SnippetRow): string | null {
  if (!row.enabled) return "Off";
  return row.usageCount > 0 ? `Used ${row.usageCount.toLocaleString()}×` : null;
}

function SnippetEditor({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor;
  onClose: () => void;
  onSaved: (row: SnippetRow, created: boolean) => void;
}) {
  const editing = editor.mode === "edit" ? editor.row : null;
  const initial = {
    trigger: editing?.trigger ?? "",
    replacement: editing?.replacement ?? "",
  };
  const [trigger, setTrigger] = useState(initial.trigger);
  const [replacement, setReplacement] = useState(initial.replacement);
  const [touched, setTouched] = useState({
    trigger: Boolean(editing),
    replacement: Boolean(editing),
  });
  // Issues from the main process's conflict check, and the input they were computed for, so a
  // stale "no issues" can never enable Save.
  const [check, setCheck] = useState<{
    key: string;
    issues: SnippetIssue[];
  } | null>(null);
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLInputElement>(null);
  const key = `${trigger}\u0000${replacement}`;

  useEffect(() => {
    let current = true;
    const t = setTimeout(
      () =>
        void hub
          .checkSnippet(
            { trigger: trigger || " ", replacement: replacement || " " },
            editing?.id ?? null,
          )
          .then((issues) => current && setCheck({ key, issues }))
          .catch((e) => current && setError(ipcErrorMessage(e))),
      120,
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [key, trigger, replacement, editing?.id]);

  useEffect(() => {
    if (!sample.trim()) {
      setPreview(null);
      return;
    }
    let current = true;
    const t = setTimeout(
      () =>
        void hub
          .previewSnippets(sample, { id: editing?.id, trigger, replacement })
          .then((text) => current && setPreview(text))
          .catch(() => current && setPreview(null)),
      120,
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [sample, trigger, replacement, editing?.id]);

  const fresh = check?.key === key;
  const v = validateSnippet({ trigger, replacement }, check?.issues ?? [], {
    showTriggerRequired: touched.trigger,
    showReplacementRequired: touched.replacement,
  });
  const dirty =
    trigger !== initial.trigger || replacement !== initial.replacement;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = { trigger: trigger.trim(), replacement };
      const row = editing
        ? await hub.updateSnippet(editing.id, input)
        : await hub.addSnippet(input);
      if (!row) throw new Error("This snippet no longer exists.");
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
      title={editing ? "Edit snippet" : "Create snippet"}
      description="When you say the trigger, Murmur inserts the text instead."
      dirty={dirty}
      canSave={fresh && v.canSave && (dirty || !editing)}
      saving={saving}
      saveLabel={editing ? "Save" : "Create snippet"}
      error={error}
      onSubmit={save}
      onInvalidSubmit={() => setTouched({ trigger: true, replacement: true })}
      initialFocus={triggerRef}
      footerStart={
        <span
          className={cn(
            "text-caption tabular-nums",
            replacement.length > REPLACEMENT_MAX * 0.9
              ? "text-warning"
              : "text-fg-tertiary",
          )}
        >
          {replacement.length.toLocaleString()} /{" "}
          {REPLACEMENT_MAX.toLocaleString()}
        </span>
      }
    >
      <div className="space-y-4">
        <Field
          label="Trigger phrase"
          hint="What you say, e.g. “my email”. Matched as whole words, ignoring capitalization."
          error={v.trigger}
        >
          {({ id, describedBy }) => (
            <Input
              ref={triggerRef}
              id={id}
              aria-describedby={describedBy}
              aria-invalid={Boolean(v.trigger)}
              value={trigger}
              maxLength={TRIGGER_MAX}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTrigger(e.target.value)}
              onBlur={() =>
                trigger && setTouched((t) => ({ ...t, trigger: true }))
              }
            />
          )}
        </Field>
        <Field
          label="Text to insert"
          hint="Inserted exactly as written, including line breaks. ⌘↩ saves."
          error={v.replacement}
        >
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              aria-invalid={Boolean(v.replacement)}
              value={replacement}
              maxLength={REPLACEMENT_MAX}
              rows={5}
              className="max-h-56"
              onChange={(e) => setReplacement(e.target.value)}
              onBlur={() =>
                replacement && setTouched((t) => ({ ...t, replacement: true }))
              }
            />
          )}
        </Field>
        {v.warnings.length > 0 && (
          <ul className="space-y-1" aria-label="Warnings">
            {v.warnings.map((w) => (
              <li
                key={w}
                className="flex items-start gap-2 text-caption text-warning"
              >
                <AlertTriangle
                  className="mt-px size-3.5 shrink-0"
                  aria-hidden
                />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="rounded-lg bg-surface p-3">
          <Field
            label="Try it"
            hint="Type a sentence to see what Murmur would insert, using this snippet and your other active ones."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={sample}
                placeholder={`e.g. send it to ${trigger.trim() || "my email"} please`}
                onChange={(e) => setSample(e.target.value)}
                // A practice sentence: Enter must not save the snippet.
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              />
            )}
          </Field>
          {preview !== null && (
            <p
              aria-live="polite"
              className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-sheet px-2.5 py-2 text-ui text-fg"
              data-selectable
            >
              {preview}
            </p>
          )}
        </div>
      </div>
    </EditorDialog>
  );
}
