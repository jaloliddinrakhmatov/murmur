// Settings as a modal over the app with its own left navigation (reference geometry: 960 × 640
// pt, 208 pt navigation on the canvas colour, white content with a fixed serif title). Each
// section is a list of settings groups (./system.tsx, ./services.tsx, ./data.tsx); the shortcut
// and language rows open focused dialogs. Changes save immediately, so the sheet can be closed
// at any time and never blocks dictation (global hotkeys live in main).
import * as RadixDialog from "@radix-ui/react-dialog";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AudioLines,
  BookA,
  Code,
  CreditCard,
  Info,
  Laptop,
  Plug,
  Server,
  NotepadText,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import type {
  SettingsDialog,
  SettingsSectionId,
} from "../model/settings-sections.ts";
import type { AppInfo } from "../../../shared/ipc.ts";
import { hub } from "../bridge.ts";
import { cn, useRestoreFocus } from "../ui/index.ts";
import { useStatus } from "../pages/shared.tsx";
import { GeneralSection, SystemSection } from "./system.tsx";
import { AiSection, TranscriptionSection } from "./services.tsx";
import { AboutSection, LibrarySection, PrivacySection } from "./data.tsx";
import { NotetakerSection } from "./notetaker.tsx";
import { AccountSection } from "./account.tsx";
import { TeamSection } from "./team.tsx";
import { BillingSection } from "./billing.tsx";
import { VibeCodingSection } from "./vibe-coding.tsx";
import { ConnectorsSection } from "./connectors.tsx";
import { McpSection } from "./mcp.tsx";

export const SETTINGS_SECTIONS: {
  id: SettingsSectionId;
  label: string;
  icon: ReactNode;
  group: "Settings" | "Integrations" | "Account" | "Murmur";
}[] = [
  {
    id: "general",
    label: "General",
    icon: <SlidersHorizontal />,
    group: "Settings",
  },
  { id: "system", label: "System", icon: <Laptop />, group: "Settings" },
  {
    id: "notetaker",
    label: "Notetaker",
    icon: <NotepadText />,
    group: "Settings",
  },
  {
    id: "transcription",
    label: "Transcription",
    icon: <AudioLines />,
    group: "Settings",
  },
  { id: "ai", label: "AI cleanup", icon: <Sparkles />, group: "Settings" },
  {
    id: "library",
    label: "Dictionary & snippets",
    icon: <BookA />,
    group: "Settings",
  },
  {
    id: "connectors",
    label: "Connectors",
    icon: <Plug />,
    group: "Integrations",
  },
  {
    id: "vibeCoding",
    label: "Vibe coding",
    icon: <Code />,
    group: "Integrations",
  },
  { id: "mcp", label: "MCP", icon: <Server />, group: "Integrations" },
  { id: "account", label: "Account", icon: <UserRound />, group: "Account" },
  { id: "team", label: "Team", icon: <Users />, group: "Account" },
  {
    id: "billing",
    label: "Plans and Billing",
    icon: <CreditCard />,
    group: "Account",
  },
  {
    id: "privacy",
    label: "Data and Privacy",
    icon: <ShieldCheck />,
    group: "Murmur",
  },
  { id: "about", label: "About", icon: <Info />, group: "Murmur" },
];

export function SettingsSheet({
  open,
  onOpenChange,
  section,
  onSection,
  dialog,
  onDialog,
  onReset,
  settings,
  update,
  navigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSectionId;
  onSection: (s: SettingsSectionId) => void;
  /** A row's focused dialog (Shortcuts, Language), opened by its row or a deep link. */
  dialog: SettingsDialog | null;
  onDialog: (d: SettingsDialog | null) => void;
  /** After a reset: the app returns to setup. */
  onReset: () => void;
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  navigate: (route: string) => void;
}) {
  const { status, refresh } = useStatus();
  const [about, setAbout] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (open && !about)
      void hub
        .about()
        .then(setAbout)
        .catch(() => {});
  }, [open, about]);
  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const current =
    SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const focus = useRestoreFocus({
    onOpenAutoFocus: (e) => {
      e.preventDefault();
      navRefs.current[
        SETTINGS_SECTIONS.findIndex((s) => s.id === section)
      ]?.focus();
    },
  });

  const onNavKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (i + d + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length;
    onSection(SETTINGS_SECTIONS[next].id);
    navRefs.current[next]?.focus();
  };

  const props = { settings, update, status, refresh };
  let body: ReactNode;
  switch (section) {
    case "general":
      body = (
        <GeneralSection
          {...props}
          about={about}
          dialog={dialog}
          onDialog={onDialog}
          openTransforms={() => {
            onDialog(null);
            onOpenChange(false);
            navigate("transforms");
          }}
        />
      );
      break;
    case "system":
      body = <SystemSection {...props} onReset={onReset} />;
      break;
    case "notetaker":
      body = (
        <NotetakerSection
          settings={settings}
          update={update}
          navigate={(route) => {
            onOpenChange(false);
            navigate(route);
          }}
        />
      );
      break;
    case "transcription":
      body = <TranscriptionSection {...props} onSection={onSection} />;
      break;
    case "ai":
      body = <AiSection settings={settings} update={update} />;
      break;
    case "library":
      body = (
        <LibrarySection
          settings={settings}
          update={update}
          navigate={(route) => {
            onOpenChange(false);
            navigate(route);
          }}
        />
      );
      break;
    case "connectors":
      body = (
        <ConnectorsSection
          settings={settings}
          update={update}
          onSection={onSection}
        />
      );
      break;
    case "vibeCoding":
      body = <VibeCodingSection {...props} />;
      break;
    case "mcp":
      body = <McpSection settings={settings} update={update} />;
      break;
    case "account":
      body = <AccountSection onSection={onSection} />;
      break;
    case "team":
      body = <TeamSection />;
      break;
    case "billing":
      body = <BillingSection />;
      break;
    case "privacy":
      body = <PrivacySection settings={settings} update={update} />;
      break;
    case "about":
      body = <AboutSection about={about} />;
      break;
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 animate-overlay-in bg-overlay" />
        <RadixDialog.Content
          aria-describedby={undefined}
          {...focus}
          // Reference: 960 × 640 pt, centred, 12 pt corners.
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(640px,calc(100vh-56px))] w-[min(960px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 animate-dialog-in overflow-hidden rounded-xl bg-modal shadow-dialog outline-none"
        >
          <RadixDialog.Title className="sr-only">Settings</RadixDialog.Title>
          <nav
            aria-label="Settings sections"
            className="flex w-52 shrink-0 flex-col bg-canvas px-2 pb-[18px] pt-[19px] max-[860px]:w-14"
          >
            <div className="flex flex-col overflow-y-auto">
              {SETTINGS_SECTIONS.map((s, i) => {
                const active = s.id === section;
                const startsGroup =
                  i === 0 || SETTINGS_SECTIONS[i - 1].group !== s.group;
                return (
                  <Fragment key={s.id}>
                    {startsGroup && (
                      <>
                        {i > 0 && (
                          <div
                            className="mx-2 mb-[17px] mt-1.5 h-px bg-hairline"
                            aria-hidden
                          />
                        )}
                        <div className="mb-[15.5px] px-2 text-micro font-medium uppercase text-fg-secondary max-[860px]:sr-only">
                          {s.group}
                        </div>
                      </>
                    )}
                    <button
                      ref={(el) => {
                        navRefs.current[i] = el;
                      }}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      tabIndex={active ? 0 : -1}
                      onClick={() => onSection(s.id)}
                      onKeyDown={(e) => onNavKey(e, i)}
                      title={s.label}
                      className={cn(
                        // Reference item: 36 pt, icon 16 pt at +10, label at +36.
                        "flex h-9 shrink-0 items-center gap-2.5 rounded-md pl-2.5 pr-2 text-ui text-fg transition-colors focus-visible:outline-offset-[-2px] duration-[var(--m-duration-fast)] max-[860px]:justify-center max-[860px]:px-0",
                        active
                          ? "bg-surface-active font-medium"
                          : "hover:bg-surface-hover",
                      )}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4 [&>svg]:stroke-[1.75]">
                        {s.icon}
                      </span>
                      <span className="truncate max-[860px]:sr-only">
                        {s.label}
                      </span>
                    </button>
                  </Fragment>
                );
              })}
            </div>
            <div className="mt-auto px-2 pt-3 text-caption text-fg-secondary max-[860px]:sr-only">
              Murmur {status?.version ? `v${status.version}` : ""}
            </div>
          </nav>
          <section
            className="relative flex min-w-0 flex-1 flex-col"
            aria-labelledby="settings-section-title"
          >
            {/* The title stays put while the section scrolls under it (reference). */}
            <div className="shrink-0 px-12 pb-[35px] pt-[43px] max-[860px]:px-6">
              <h2
                id="settings-section-title"
                className="font-serif text-display tracking-[-0.01em] text-fg"
              >
                {current.label}
              </h2>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
              <div
                key={section}
                // 48 pt each side: the stable scrollbar gutter (10 pt) is part of the right side.
                className="animate-fade-in space-y-6 pb-12 pl-12 pr-[38px] max-[860px]:pl-6 max-[860px]:pr-4"
              >
                {body}
              </div>
            </div>
            <RadixDialog.Close asChild>
              <button
                type="button"
                aria-label="Close settings"
                className="absolute right-4 top-4 flex size-8 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-hover hover:text-fg"
              >
                <X className="size-4" aria-hidden />
              </button>
            </RadixDialog.Close>
          </section>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
