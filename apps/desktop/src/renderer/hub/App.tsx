import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookA,
  ChartColumn,
  Mic,
  Scissors,
  NotebookPen,
  NotepadText,
  Gift,
  Settings,
  Type,
  UsersRound,
  Wand2,
} from "lucide-react";
import { hub } from "./bridge.ts";
import { pendingSaves } from "./model/notetaker.ts";
import { ToastProvider, TooltipProvider } from "./ui/index.ts";
import {
  AppShell,
  Sidebar,
  TitleBar,
  useSidebar,
  type NavEntry,
} from "./shell/shell.tsx";
import { SettingsSheet } from "./settings/SettingsSheet.tsx";
import {
  isSettingsTarget,
  resolveSettingsTarget,
  type SettingsDialog,
  type SettingsSectionId,
  type SettingsTarget,
} from "./model/settings-sections.ts";
import { useSettings } from "./pages/shared.tsx";
import { DictationPage } from "./pages/home.tsx";
import { DictionaryPage } from "./pages/dictionary.tsx";
import { SnippetsPage } from "./pages/snippets.tsx";
import { Onboarding } from "./pages/onboarding.tsx";
import { StylePage } from "./pages/style.tsx";
import { InsightsPage } from "./pages/insights.tsx";
import { ScratchpadPage } from "./pages/scratchpad.tsx";
import { TransformsPage } from "./pages/transforms.tsx";
import { NotetakerPage } from "./pages/notetaker.tsx";
import { NotetakerSetupCard, SetupCard } from "./shell/setup-card.tsx";
import { AccountMenu } from "./account/menu.tsx";
import { AccountDialogs, openRefer } from "./account/ui.tsx";

type Page =
  | "home"
  | "notetaker"
  | "insights"
  | "dictionary"
  | "snippets"
  | "style"
  | "transforms"
  | "scratchpad";

// Reference order (supported destinations only). The home route keeps its id; its label is
// the reference's “Dictation”, and it holds the complete History (Stage 4). Notetaker sits
// second, as in the reference, but takes ⌘8 so the existing ⌘1–⌘7 keep their pages.
const NAV: NavEntry<Page>[] = [
  { route: "home", label: "Dictation", icon: <Mic />, shortcut: "⌘1" },
  {
    route: "notetaker",
    label: "Notetaker",
    icon: <NotepadText />,
    shortcut: "⌘8",
  },
  {
    route: "insights",
    label: "Insights",
    icon: <ChartColumn />,
    shortcut: "⌘2",
  },
  { route: "dictionary", label: "Dictionary", icon: <BookA />, shortcut: "⌘3" },
  { route: "snippets", label: "Snippets", icon: <Scissors />, shortcut: "⌘4" },
  { route: "style", label: "Style", icon: <Type />, shortcut: "⌘5" },
  {
    route: "transforms",
    label: "Transforms",
    icon: <Wand2 />,
    shortcut: "⌘6",
  },
  {
    route: "scratchpad",
    label: "Scratchpad",
    icon: <NotebookPen />,
    shortcut: "⌘7",
  },
];

/**
 * Routes arrive as "#home", "history/<id>", "settings", "settings/transcription" (tray menu,
 * deep links, capture). History lives on Dictation now: "history" opens Dictation and
 * "history/<id>" opens it scrolled to (or showing the details of) that dictation.
 */
function parseRoute(raw: string): {
  page?: Page;
  focus?: string;
  settings?: SettingsTarget | true;
  onboarding?: true;
} {
  const [head, sub] = raw.replace(/^#/, "").split("/");
  if (head === "onboarding") return { onboarding: true };
  if (head === "settings")
    return { settings: isSettingsTarget(sub) ? sub : true };
  if (head === "history") return { page: "home", focus: sub || undefined };
  // "notetaker/setup" opens Set up Notetaker, "notetaker/new" starts a note.
  if (head === "notetaker")
    return { page: "notetaker", focus: sub || undefined };
  if (
    head === "home" ||
    head === "insights" ||
    head === "dictionary" ||
    head === "snippets" ||
    head === "style" ||
    head === "transforms" ||
    head === "scratchpad"
  )
    return { page: head };
  return {};
}

export function App() {
  const initial = parseRoute(location.hash);
  const [page, setPage] = useState<Page>(initial.page ?? "home");
  const [focus, setFocus] = useState<string | undefined>(initial.focus);
  const [onboarding, setOnboarding] = useState(Boolean(initial.onboarding));
  const [settingsOpen, setSettingsOpen] = useState(Boolean(initial.settings));
  const initialTarget =
    initial.settings && initial.settings !== true
      ? resolveSettingsTarget(initial.settings)
      : null;
  const [section, setSection] = useState<SettingsSectionId>(
    initialTarget?.section ?? "general",
  );
  const [dialog, setDialog] = useState<SettingsDialog | null>(
    initialTarget?.dialog ?? null,
  );
  const { settings, update, reload } = useSettings();
  // A row's dialog belongs to that visit: closing Settings by any route forgets it.
  useEffect(() => {
    if (!settingsOpen) setDialog(null);
  }, [settingsOpen]);
  const sidebar = useSidebar();
  // Quit: save typed meeting notes before the app closes (main waits for the reply).
  useEffect(
    () =>
      hub.onFlushRequest((requestId) => {
        void pendingSaves.flushAll().finally(() => hub.flushed(requestId));
      }),
    [],
  );

  // Unfinished setup opens onboarding once, when the window loads; an explicit navigation
  // (tray menu, deep link) can still leave it, as before the redesign.
  const onboardingChecked = useRef(false);
  useEffect(() => {
    if (!settings || onboardingChecked.current) return;
    onboardingChecked.current = true;
    if (!settings.onboardingCompleted) setOnboarding(true);
  }, [settings]);

  const clearFocus = useCallback(() => setFocus(undefined), []);
  const go = useCallback((raw: string) => {
    const r = parseRoute(raw);
    if (r.onboarding) setOnboarding(true);
    if (r.page || r.settings) setOnboarding(false);
    if (r.page) {
      setPage(r.page);
      setFocus(r.focus);
      setSettingsOpen(false);
    }
    if (r.settings) {
      if (r.settings !== true) {
        const t = resolveSettingsTarget(r.settings);
        setSection(t.section);
        setDialog(t.dialog);
      }
      setSettingsOpen(true);
    }
  }, []);
  useEffect(() => hub.onNavigate(go), [go]);

  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;

  // macOS conventions: ⌘, settings · ⌃⌘S sidebar · ⌘1–8 pages (each entry's own shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((o) => !o);
      } else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        sidebar.toggle();
      } else if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const entry = NAV.find((n) => n.shortcut === `⌘${e.key}`);
        if (!entry) return;
        // Another dialog (an edit sheet, a discard prompt) keeps the keyboard: leaving the page
        // would drop its unsaved changes without asking. Settings itself may be navigated away from.
        const dialogs = document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"]',
        ).length;
        if (dialogs > (settingsOpenRef.current ? 1 : 0)) return;
        e.preventDefault();
        setPage(entry.route);
        setFocus(undefined);
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebar]);

  if (!settings) return <div className="h-full bg-canvas" />;
  if (onboarding) {
    return (
      <TooltipProvider>
        <ToastProvider>
          <Onboarding
            settings={settings}
            update={update}
            done={() => {
              setOnboarding(false);
              setPage("home");
            }}
          />
          <AccountDialogs />
        </ToastProvider>
      </TooltipProvider>
    );
  }

  const openSettings = (target: SettingsTarget) => {
    const t = resolveSettingsTarget(target);
    setSection(t.section);
    setDialog(t.dialog);
    setSettingsOpen(true);
  };
  return (
    <TooltipProvider>
      <ToastProvider>
        <AppShell
          pageKey={page}
          wide={page === "home" || page === "insights"}
          bleed={page === "notetaker"}
          titleBar={
            <TitleBar
              collapsed={sidebar.collapsed}
              canCollapse={!sidebar.narrow}
              onToggleSidebar={sidebar.toggle}
              appearance={settings.appearance}
              onAppearance={(a) => update({ appearance: a })}
              account={<AccountMenu navigate={go} />}
            />
          }
          sidebar={
            <Sidebar
              collapsed={sidebar.collapsed}
              items={NAV}
              current={page}
              onNavigate={(p) => {
                setPage(p);
                setFocus(undefined);
              }}
              extras={[
                {
                  route: "invite-team",
                  label: "Invite your team",
                  icon: <UsersRound />,
                  onSelect: () => openSettings("team"),
                },
                {
                  route: "free-month",
                  label: "Get a free month",
                  icon: <Gift />,
                  onSelect: openRefer,
                },
              ]}
              footer={{
                route: "settings",
                label: "Settings",
                icon: <Settings />,
                shortcut: "⌘,",
                active: settingsOpen,
                onSelect: () => setSettingsOpen(true),
              }}
              setup={
                <>
                  <SetupCard
                    collapsed={sidebar.collapsed}
                    openSettings={openSettings}
                  />
                  <NotetakerSetupCard
                    collapsed={sidebar.collapsed}
                    settings={settings}
                    navigate={go}
                  />
                </>
              }
            />
          }
        >
          {page === "home" && (
            <DictationPage
              settings={settings}
              update={update}
              openSettings={openSettings}
              focusId={focus}
              onFocusHandled={() => setFocus(undefined)}
            />
          )}
          {page === "notetaker" && (
            <NotetakerPage
              settings={settings}
              update={update}
              openSettings={openSettings}
              focusId={focus}
              onFocusHandled={clearFocus}
            />
          )}
          {page === "insights" && (
            <InsightsPage settings={settings} openSettings={openSettings} />
          )}
          {page === "transforms" && (
            <TransformsPage
              settings={settings}
              update={update}
              openSettings={openSettings}
            />
          )}
          {page === "scratchpad" && <ScratchpadPage settings={settings} />}
          {page === "dictionary" && (
            <DictionaryPage settings={settings} update={update} />
          )}
          {page === "snippets" && (
            <SnippetsPage settings={settings} update={update} />
          )}
          {page === "style" && (
            <StylePage
              settings={settings}
              update={update}
              openSettings={openSettings}
            />
          )}
        </AppShell>
        <SettingsSheet
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          section={section}
          onSection={setSection}
          dialog={dialog}
          onDialog={setDialog}
          onReset={async () => {
            // Reset restores default settings: read them again, then run setup.
            setSettingsOpen(false);
            await reload();
            setPage("home");
            setOnboarding(true);
          }}
          settings={settings}
          update={update}
          navigate={go}
        />
        <AccountDialogs />
      </ToastProvider>
    </TooltipProvider>
  );
}
