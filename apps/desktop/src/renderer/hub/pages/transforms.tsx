// Transforms (Stage 9C, references 08–11): opt in, the "view changes" shortcut, a banner, and
// My Transforms — Polish and Prompt Engineer (reset, not deleted) plus your own. Each opens a
// split editor that saves as you change it. Running a Transform happens in other apps (select
// text, press its shortcut) or in Scratchpad; nothing here sends text unless you press See Updates.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Info,
  Plus,
  RotateCcw,
  Trash2,
  Wand2,
  FileText,
  Mail,
  MessageSquare,
  NotebookPen,
  Code2,
  Sparkles,
} from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import type { TransformWithStatus } from "../../../shared/ipc.ts";
import {
  POLISH_RULES,
  TRANSFORM_EXAMPLES,
  TRANSFORM_NAME_MAX,
  TRANSFORM_PROMPT_MAX,
  TRANSFORM_TEMPLATES,
  type PolishRules,
  type Transform,
} from "../../../shared/transforms.ts";
import { hub } from "../bridge.ts";
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  IconButton,
  InlineAlert,
  Input,
  Kbd,
  SearchToggle,
  Skeleton,
  Switch,
  Textarea,
  Tooltip,
  cn,
  useToast,
} from "../ui/index.ts";
import { PageHeader } from "../shell/shell.tsx";
import { ipcErrorMessage } from "../model/errors.ts";
import { shortcutMessage } from "../model/settings.ts";
import {
  ActionField,
  clearActionShortcut,
  MessageLine,
  saveActionShortcut,
  ShortcutRecorder,
  type ShortcutMessage,
} from "../settings/shortcuts-dialog.tsx";
import { EditingConflictLine } from "../settings/editing-conflict.tsx";
import { useStatus } from "./shared.tsx";
import type { SettingsTarget } from "../model/settings-sections.ts";

type Editing = { mode: "edit"; id: string } | { mode: "create" } | null;

export function TransformsPage({
  settings,
  update,
  openSettings,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  openSettings: (target: SettingsTarget) => void;
}) {
  const toast = useToast();
  const { status } = useStatus();
  const [list, setList] = useState<TransformWithStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [resetting, setResetting] = useState(false);
  const [howItWorks, setHowItWorks] = useState(false);
  const [message, setMessage] = useState<ShortcutMessage>(null);

  const load = useCallback(async () => {
    try {
      setList(await hub.transforms(search));
      setError(null);
    } catch (e) {
      setError(ipcErrorMessage(e));
    }
  }, [search]);
  useEffect(() => {
    void load();
    return hub.onTransformsChanged(() => void load());
  }, [load]);

  const optIn = settings.transforms.optIn;
  const viewChanges = status?.actions.transformViewChanges ?? null;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            Transforms
            <span className="inline-flex h-6 items-center rounded-sm bg-fg px-1.5 text-caption font-medium text-canvas">
              Beta
            </span>
          </span>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-3">
              <label htmlFor="transforms-opt-in" className="text-ui text-fg">
                Opt in
              </label>
              <Tooltip
                content="Transform shortcuts (such as ⌃⌥1) are registered only while this is on, so they take no keys from other apps until you want them."
                side="bottom"
              >
                <button
                  type="button"
                  aria-label="About opting in"
                  className="no-drag flex size-4 items-center justify-center rounded-xs text-fg-secondary hover:text-fg"
                >
                  <Info className="size-3.5" aria-hidden />
                </button>
              </Tooltip>
              <Switch
                id="transforms-opt-in"
                label="Opt in to Transforms"
                checked={optIn}
                onCheckedChange={(on) =>
                  void update({ transforms: { optIn: on } }).catch((e) =>
                    toast({
                      title: "Couldn't change it",
                      description: ipcErrorMessage(e),
                      tone: "error",
                    }),
                  )
                }
              />
              <div className="flex items-center gap-2">
                <ActionField
                  action="transformViewChanges"
                  current={
                    viewChanges?.combo ??
                    settings.shortcuts.transformViewChanges
                  }
                  placeholder="Set a shortcut"
                  save={(combo) =>
                    saveActionShortcut(
                      "transformViewChanges",
                      combo,
                      setMessage,
                    )
                  }
                  clear={() =>
                    void clearActionShortcut("transformViewChanges", setMessage)
                  }
                  onMessage={setMessage}
                  variant="pill"
                />
                <span className="text-ui text-fg">to view changes</span>
              </div>
            </div>
            <span id="shortcut-transformViewChanges-desc" className="sr-only">
              Shows the last Transform again, with Copy.
            </span>
            {message && (
              <span className="max-w-[360px] text-right text-caption">
                <MessageLine message={message} />
              </span>
            )}
          </div>
        }
      />
      <Banner
        scene="transforms"
        // Reference 08: 199 pt tall, 26 pt below the header row (as on Scratchpad).
        className="-mt-[19px] min-h-[199px]"
        tight
        title="Transforms work anywhere you write"
        actions={
          <>
            <Button
              variant="banner"
              onClick={() => setEditing({ mode: "edit", id: "polish" })}
            >
              Try it out
            </Button>
            <button
              type="button"
              onClick={() => setHowItWorks(true)}
              className="no-drag h-9 px-3 text-ui font-medium text-on-image hover:underline"
            >
              How it works
            </button>
          </>
        }
        aside={<AppOrbit />}
      >
        <p className="max-w-[380px]">
          Select text in any app and press a Transform's shortcut to rewrite,
          clean up or restructure it.
        </p>
      </Banner>

      {!optIn && (
        <p className="mt-6 text-caption text-fg-secondary">
          Transforms are off: their shortcuts do nothing until you opt in. You
          can still use them from Scratchpad's ✨ menu and from History.
        </p>
      )}

      <div className="mb-6 mt-10 flex flex-wrap items-center gap-3">
        <h2 className="flex-1 font-serif text-[34px] leading-[40px] tracking-[-0.01em] text-fg">
          My Transforms
        </h2>
        <SearchToggle
          value={search}
          onValueChange={setSearch}
          label="Search Transforms"
          placeholder="Search Transforms"
        />
        <Button
          variant="ghost"
          icon={<RotateCcw />}
          onClick={() => setResetting(true)}
        >
          Reset to defaults
        </Button>
        <Button
          variant="primary"
          onClick={() => setEditing({ mode: "create" })}
        >
          Create New
        </Button>
      </div>

      {error ? (
        <InlineAlert
          tone="danger"
          icon={<Info />}
          action={
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          Couldn't load your Transforms: {error}
        </InlineAlert>
      ) : !list ? (
        <Skeleton className="h-56 rounded-list" />
      ) : (
        <ul
          aria-label="My Transforms"
          className="grid grid-cols-3 gap-[18px] max-[1000px]:grid-cols-2"
        >
          {list.map((t) => (
            <li key={t.id}>
              <TransformCard
                t={t}
                optIn={optIn}
                onOpen={() => setEditing({ mode: "edit", id: t.id })}
              />
            </li>
          ))}
          {!search && (
            <li>
              <button
                type="button"
                onClick={() => setEditing({ mode: "create" })}
                className="no-drag flex h-full min-h-[162px] w-full flex-col items-start rounded-list border border-hairline bg-sheet px-6 py-5 text-left hover:bg-surface-hover"
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-surface text-fg">
                  <Plus className="size-3.5" aria-hidden />
                </span>
                <span className="mt-6 text-[17px] font-medium text-fg">
                  Create your own
                </span>
                <span className="mt-2 text-ui text-fg-secondary">
                  Write your own instruction
                </span>
              </button>
            </li>
          )}
          {search && list.length === 0 && (
            <li className="col-span-full py-16 text-center text-ui text-fg-secondary">
              No Transforms match “{search}”
            </li>
          )}
        </ul>
      )}

      <TransformEditor
        editing={editing}
        list={list ?? []}
        optIn={optIn}
        onClose={() => setEditing(null)}
        onCreated={(id) => setEditing({ mode: "edit", id })}
        openSettings={openSettings}
      />
      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset Polish and Prompt Engineer?"
        description="Their names, rules, prompt and shortcuts go back to the defaults. Transforms you created are kept."
        confirmLabel="Reset to defaults"
        onConfirm={async () => {
          await hub.resetTransforms();
          toast({ title: "Reset to defaults", tone: "success" });
        }}
      />
      <HowItWorks open={howItWorks} onOpenChange={setHowItWorks} />
    </div>
  );
}

function TransformCard({
  t,
  optIn,
  onOpen,
}: {
  t: TransformWithStatus;
  optIn: boolean;
  onOpen: () => void;
}) {
  const problem = optIn && t.shortcut && t.status && !t.status.registered;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${t.name}${t.shortcut ? `, shortcut ${t.shortcut}` : ""}. Edit`}
      className="no-drag flex h-full min-h-[162px] w-full flex-col items-start rounded-list border border-hairline bg-sheet px-6 py-5 text-left hover:bg-surface-hover"
    >
      <span className="flex h-7 items-center">
        {t.shortcut ? (
          <Kbd combo={t.shortcut} className={cn(!optIn && "opacity-60")} />
        ) : (
          <span className="text-caption text-fg-secondary">No shortcut</span>
        )}
      </span>
      <span
        className="mt-6 line-clamp-2 w-full break-words text-[17px] font-medium text-fg"
        title={t.name}
      >
        {t.name}
      </span>
      <span
        className="mt-2 line-clamp-3 w-full break-words text-ui text-fg-secondary"
        title={t.description}
      >
        {t.description}
      </span>
      {problem && (
        <span className="mt-3 text-caption text-danger">
          Shortcut not active: {shortcutMessage(t.status!.error ?? "")}
        </span>
      )}
      <EditingConflictLine
        combo={t.shortcut}
        className="mt-3 block text-caption text-warning"
      />
    </button>
  );
}

/** Original artwork: generic writing-app glyphs in soft circles (no app logos). */
function AppOrbit() {
  const glyphs: [ReactNode, string][] = [
    [<Mail key="m" />, "right-[200px] bottom-[150px]"],
    [<MessageSquare key="c" />, "right-[90px] bottom-[150px]"],
    [<NotebookPen key="n" />, "right-[250px] bottom-[60px]"],
    [<FileText key="f" />, "right-[140px] bottom-[75px]"],
    [<Code2 key="d" />, "right-[40px] bottom-[60px]"],
    [<Sparkles key="s" />, "right-[300px] bottom-[-10px]"],
    [<Wand2 key="w" />, "right-[190px] bottom-[-10px]"],
  ];
  return (
    <div className="relative h-[226px] w-[360px]">
      {glyphs.map(([g, pos], i) => (
        <span
          key={i}
          className={cn(
            "absolute flex size-[54px] items-center justify-center rounded-full bg-on-image/15 text-on-image ring-1 ring-on-image/25 [&_svg]:size-6",
            pos,
          )}
        >
          {g}
        </span>
      ))}
    </div>
  );
}

function HowItWorks({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const steps = [
    "Turn on Opt in, so the Transform shortcuts work.",
    "Select text in any app (or in Scratchpad), then press a Transform's shortcut, such as ⌃⌥1 for Polish. Shortcuts need Control or Command; Option alone can't be used.",
    "Murmur sends only the selected text to your AI service and shows the result. Nothing changes yet.",
    "Choose Replace to put the result in place of your selection, or Copy result. Murmur checks the selection hasn't changed first.",
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader
          title="How Transforms work"
          description="They rewrite text you select, only when you ask."
        />
        <ol className="list-decimal space-y-2 pl-5 text-ui text-fg">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <p className="mt-4 text-caption text-fg-secondary">
          Reading a selection needs Accessibility access. Without it, copy the
          text and choose Use copied text. Password fields are never read.
        </p>
        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Editor (references 09–11) -------------------------------------------------------------------

function TransformEditor({
  editing,
  list,
  optIn,
  onClose,
  onCreated,
  openSettings,
}: {
  editing: Editing;
  list: TransformWithStatus[];
  optIn: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
  openSettings: (target: SettingsTarget) => void;
}) {
  const t =
    editing?.mode === "edit"
      ? (list.find((x) => x.id === editing.id) ?? null)
      : null;
  const creating = editing?.mode === "create";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rules, setRules] = useState<PolishRules | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<ShortcutMessage>(null);
  const loadedFor = useRef<string | null>(null);

  // Fill the fields when a different transform (or Create) opens.
  useEffect(() => {
    const key = editing
      ? editing.mode === "edit"
        ? editing.id
        : "create"
      : null;
    if (key === loadedFor.current) return;
    if (editing?.mode === "edit" && !t) return;
    loadedFor.current = key;
    setName(t?.name ?? "");
    setDescription(t?.description ?? "");
    setPrompt(t?.prompt ?? "");
    setRules(t?.rules ?? null);
    setSaveError(null);
    setMessage(null);
  }, [editing, t]);

  // Autosave: a short pause after typing, at once for switches.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback(
    async (patch: {
      name?: string;
      description?: string;
      prompt?: string;
      rules?: PolishRules;
    }) => {
      setSaving(true);
      try {
        if (editing?.mode === "edit") {
          await hub.updateTransform({ id: editing.id, ...patch });
        } else if (creating) {
          const n = (patch.name ?? name).trim();
          const p = (patch.prompt ?? prompt).trim();
          if (!n || !p) return; // saved once it has a name and an instruction
          const created = await hub.createTransform({
            name: n,
            description: (patch.description ?? description).trim(),
            prompt: p,
          });
          loadedFor.current = created.id;
          onCreated(created.id);
        }
        setSaveError(null);
      } catch (e) {
        setSaveError(ipcErrorMessage(e));
      } finally {
        setSaving(false);
      }
    },
    [editing, creating, name, prompt, description, onCreated],
  );
  // Edits wait for a pause; patches from different fields are merged so none is lost.
  const pending = useRef<Parameters<typeof save>[0]>({});
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) void saveRef.current(patch);
  }, []);
  const saveSoon = (patch: Parameters<typeof save>[0]) => {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 500);
  };
  // Leaving the page (not just closing the dialog) must not drop a pending edit.
  useEffect(() => flush, [flush]);

  const kind = t?.kind ?? "custom";
  const title = creating ? "Create your own" : (t?.name ?? "");
  const example =
    kind === "polish" || kind === "prompt-engineer"
      ? TRANSFORM_EXAMPLES[kind]
      : null;

  return (
    <Dialog
      open={editing !== null}
      onOpenChange={(o) => {
        if (!o) {
          flush();
          onClose();
        }
      }}
    >
      <DialogContent
        // Reference 09–11: a split dialog, 960 × 655 pt, left column 320 pt.
        size="custom"
        bare
        className="h-[min(655px,calc(100vh-48px))] w-[min(960px,calc(100vw-48px))] flex-row"
        aria-describedby={undefined}
        // Esc while recording a shortcut cancels the recording, not the editor.
        onEscapeKeyDown={(e) => {
          if (document.activeElement?.closest("[data-shortcut-recording]"))
            e.preventDefault();
        }}
      >
        <div className="flex w-[320px] shrink-0 flex-col overflow-y-auto bg-modal p-7 max-[760px]:hidden">
          <h2 className="font-serif text-[34px] leading-[40px] tracking-[-0.01em] text-fg">
            {title}
          </h2>
          {t?.shortcut && (
            <p className="mt-6 inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1.5 text-ui text-fg">
              <Kbd combo={t.shortcut} /> to use
            </p>
          )}
          <p className="mt-6 text-ui text-fg">
            {example?.about ??
              (creating
                ? "Write an instruction and set a shortcut to apply this Transform to text you select."
                : t?.description)}
          </p>
          {creating && (
            <div className="mt-6">
              <h3 className="text-ui font-semibold text-fg">Start from</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                {TRANSFORM_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.key}
                    type="button"
                    onClick={() => {
                      setName(tpl.name);
                      setDescription(tpl.description);
                      setPrompt(tpl.prompt);
                      void save({
                        name: tpl.name,
                        description: tpl.description,
                        prompt: tpl.prompt,
                      });
                    }}
                    className="no-drag rounded-full bg-surface px-3 py-1 text-caption text-fg hover:bg-surface-hover"
                  >
                    {tpl.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {t && <ExampleBlock t={t} openSettings={openSettings} />}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-sheet p-7">
          <div className="mb-5 flex items-center justify-end gap-4">
            <span className="text-caption text-fg-secondary" role="status">
              {saving ? "Saving…" : saveError ? "" : "Autosave On"}
            </span>
            {t?.builtIn && (
              <Button
                variant="ghost"
                icon={<RotateCcw />}
                onClick={() => setResetting(true)}
              >
                Reset
              </Button>
            )}
            {t && !t.builtIn && (
              <Button
                variant="ghost"
                icon={<Trash2 />}
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            )}
          </div>
          {saveError && (
            <p
              role="alert"
              className="mb-4 rounded-md bg-danger-soft p-3 text-ui text-fg"
            >
              {saveError}
            </p>
          )}

          {(creating || kind === "custom") && (
            <Section
              title={
                <label htmlFor="transform-name">Name your Transform</label>
              }
            >
              <Input
                id="transform-name"
                autoFocus={creating}
                maxLength={TRANSFORM_NAME_MAX}
                placeholder="Board update"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (e.target.value.trim()) saveSoon({ name: e.target.value });
                }}
              />
              <label
                htmlFor="transform-description"
                className="mt-4 block text-caption text-fg-secondary"
              >
                Description (optional)
              </label>
              <Input
                id="transform-description"
                className="mt-1"
                maxLength={120}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  saveSoon({ description: e.target.value });
                }}
              />
            </Section>
          )}

          <Section
            title={
              <label htmlFor={`transform-shortcut-${t?.id ?? "new"}`}>
                Choose a keyboard shortcut
              </label>
            }
          >
            {t ? (
              <div className="flex h-[43px] items-center rounded-md bg-modal pr-1.5 shadow-[inset_0_0_0_1px_var(--m-hairline-strong)] has-[[data-shortcut-recording]]:bg-accent-faint">
                <ShortcutRecorder
                  id={`transform-shortcut-${t.id}`}
                  name={t.name}
                  current={t.shortcut}
                  placeholder="Click to add a shortcut"
                  inline
                  onMessage={setMessage}
                  save={async (combo) => {
                    try {
                      await hub.setTransformShortcut(t.id, combo);
                      setMessage({
                        tone: "success",
                        text: optIn
                          ? "Saved. It works in any app now."
                          : "Saved. It works once you opt in.",
                      });
                      return true;
                    } catch (e) {
                      setMessage({
                        tone: "danger",
                        text: shortcutMessage(ipcErrorMessage(e)),
                      });
                      return false;
                    }
                  }}
                />
                {t.shortcut && (
                  <IconButton
                    size="sm"
                    label={`Remove the ${t.name} shortcut`}
                    icon={<Trash2 className="size-4" aria-hidden />}
                    onClick={async () => {
                      await hub.setTransformShortcut(t.id, null);
                      setMessage({ tone: "success", text: "Removed." });
                    }}
                  />
                )}
              </div>
            ) : (
              <p className="text-caption text-fg-secondary">
                Add a name and an instruction first; then you can set a
                shortcut.
              </p>
            )}
            <span
              id={`transform-shortcut-${t?.id ?? "new"}-desc`}
              className="mt-1.5 block text-caption"
            >
              {message ? (
                <MessageLine message={message} />
              ) : (
                <EditingConflictLine combo={t?.shortcut} />
              )}
            </span>
          </Section>

          {kind === "polish" && rules && (
            <Section title="Select rules for Polish">
              <ul className="divide-y divide-hairline">
                {POLISH_RULES.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between py-3.5"
                  >
                    <label htmlFor={`rule-${r.id}`} className="text-ui text-fg">
                      {r.label}
                    </label>
                    <Switch
                      id={`rule-${r.id}`}
                      label={r.label}
                      checked={rules[r.id]}
                      onCheckedChange={(on) => {
                        const next = { ...rules, [r.id]: on };
                        setRules(next);
                        void save({ rules: next });
                      }}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {(kind === "prompt-engineer" || kind === "custom" || creating) && (
            <Section
              title={
                <label htmlFor="transform-prompt">
                  {kind === "prompt-engineer"
                    ? "Customize prompt (the structure of the prompt it writes)"
                    : "Customize prompt"}
                </label>
              }
            >
              <Textarea
                id="transform-prompt"
                rows={9}
                maxLength={TRANSFORM_PROMPT_MAX}
                placeholder="How should this Transform change your text?"
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value);
                  if (kind === "prompt-engineer" || e.target.value.trim())
                    saveSoon({ prompt: e.target.value });
                }}
                className="font-mono text-caption"
              />
              {kind === "prompt-engineer" && !prompt.trim() && (
                <p className="mt-1.5 text-caption text-fg-secondary">
                  Empty: the default structure is used.
                </p>
              )}
            </Section>
          )}
        </div>

        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          title={`Delete “${t?.name ?? ""}”?`}
          description="Its shortcut is removed too. This can't be undone."
          confirmLabel="Delete Transform"
          destructive
          onConfirm={async () => {
            if (!t) return;
            if (!(await hub.deleteTransform(t.id)))
              throw new Error("This Transform was already deleted.");
            onClose();
          }}
        />
        <ConfirmDialog
          open={resetting}
          onOpenChange={setResetting}
          title={`Reset ${t?.name ?? ""}?`}
          description="Polish and Prompt Engineer go back to their default name, rules, prompt and shortcut."
          confirmLabel="Reset"
          onConfirm={async () => {
            await hub.resetTransforms();
            loadedFor.current = null;
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 rounded-list bg-surface p-6">
      <h3 className="mb-3 text-ui font-semibold text-fg">{title}</h3>
      {children}
    </section>
  );
}

/** "See Updates": the transform applied to its example — a real request, after consent. */
function ExampleBlock({
  t,
  openSettings,
}: {
  t: Transform;
  openSettings: (target: SettingsTarget) => void;
}) {
  const example =
    t.kind === "custom"
      ? TRANSFORM_EXAMPLES.polish
      : TRANSFORM_EXAMPLES[t.kind];
  const [after, setAfter] = useState<string | null>(null);
  // Your own Transforms: an editable sample (say, an Uzbek sentence for a translation).
  const [sample, setSample] = useState(example.example);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  useEffect(() => {
    setAfter(null);
    setError(null);
    setSample(example.example);
  }, [t.id, example.example]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setAfter(
        (
          await hub.runTransformExample(
            t.id,
            t.kind === "custom" ? sample : undefined,
          )
        ).after,
      );
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    const s = await hub.transformsAiStatus();
    if (s.ready !== null) {
      setError(
        `Set up ${s.service} in Settings → AI cleanup first. Nothing was sent.`,
      );
      return;
    }
    if (!s.consented) setAsk(s.service);
    else void run();
  };
  return (
    <div className="mt-6 border-t border-hairline pt-6">
      <h3 className="text-ui font-semibold text-fg">
        Example of transformed text
      </h3>
      {t.kind === "custom" ? (
        <>
          <label
            htmlFor={`example-${t.id}`}
            className="mt-3 block text-caption text-fg-secondary"
          >
            Try it on a sample: type or paste one
          </label>
          <Textarea
            id={`example-${t.id}`}
            className="mt-1"
            rows={5}
            maxLength={2000}
            value={sample}
            onChange={(e) => {
              setSample(e.target.value);
              setAfter(null);
            }}
          />
        </>
      ) : (
        <p
          className={cn(
            "mt-3 whitespace-pre-wrap text-ui",
            after ? "text-fg-secondary line-through" : "text-fg-secondary",
          )}
        >
          {example.example}
        </p>
      )}
      {after && (
        <p className="mt-3 whitespace-pre-wrap rounded-md bg-accent-faint p-2 text-ui text-fg">
          {after}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-caption text-danger">
          {error}{" "}
          {/Settings → AI cleanup/.test(error) && (
            <button
              type="button"
              className="underline"
              onClick={() => openSettings("ai")}
            >
              Open AI settings
            </button>
          )}
        </p>
      )}
      <Button
        className="mt-4 w-full"
        variant="primary"
        loading={busy}
        onClick={() => void start()}
      >
        {after ? "See Updates again" : "See Updates"}
      </Button>
      <p className="mt-2 text-caption text-fg-secondary">
        {t.kind === "custom"
          ? "Sends this sample to your AI service."
          : "Sends this example (not your own text) to your AI service."}
      </p>
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(o) => !o && setAsk(null)}
        title={`Send text to ${ask ?? ""}?`}
        description={`Transforms send the text you choose to ${ask ?? ""}, the AI service in Settings → AI cleanup, only when you use one. This also covers Scratchpad's AI edits.`}
        confirmLabel={`Allow ${ask ?? ""}`}
        onConfirm={async () => {
          await hub.allowTransformsAi();
          setAsk(null);
          void run();
        }}
      />
    </div>
  );
}
