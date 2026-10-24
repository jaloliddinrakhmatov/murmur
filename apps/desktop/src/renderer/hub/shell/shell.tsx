// Application shell: hidden-title-bar chrome, collapsible icon sidebar, rounded content sheet.
// Geometry is measured from the design reference screenshots; identity (name, mark, accent) is Murmur's.
import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, PanelLeft, Sun } from "lucide-react";
import {
  cn,
  IconButton,
  Menu,
  MenuContent,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  Tooltip,
} from "../ui/index.ts";
import type { Settings } from "../../../shared/settings.ts";

/** Murmur's mark: an ink capsule with an ember dot (the floating Capsule, at rest). */
export function MurmurMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <rect x="2" y="7" width="20" height="10" rx="5" className="fill-fg" />
      <circle cx="16" cy="12" r="2.1" className="fill-accent" />
    </svg>
  );
}

export interface NavEntry<R extends string> {
  route: R;
  label: string;
  icon: ReactNode;
  shortcut?: string;
}

const COLLAPSE_KEY = "murmur.sidebar.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Sidebar preference (persisted) plus a forced collapse when the window is narrow. */
export function useSidebar() {
  const [preferCollapsed, setPreferCollapsed] = useState(readCollapsed);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 860);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 860);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const toggle = () =>
    setPreferCollapsed((c) => {
      const next = narrow ? false : !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Storage unavailable: the preference lasts for this session only.
      }
      return next;
    });
  return { collapsed: narrow || preferCollapsed, narrow, toggle };
}

function NavItem<R extends string>({
  entry,
  active,
  collapsed,
  onSelect,
}: {
  entry: NavEntry<R>;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  const button = (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? entry.label : undefined}
      className={cn(
        // Reference item: 36 pt tall, icon 18 pt at x 19, label at x 49 (15 pt).
        "no-drag group flex h-9 w-full shrink-0 items-center gap-3 rounded-md text-ui font-medium text-fg transition-colors duration-[var(--m-duration-fast)]",
        collapsed ? "justify-center px-0" : "pl-[7px] pr-2",
        active ? "bg-surface-active" : "hover:bg-surface-hover",
      )}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center [&>svg]:size-[18px] [&>svg]:stroke-2">
        {entry.icon}
      </span>
      <span
        className={cn(
          "truncate transition-opacity duration-[var(--m-duration-base)]",
          collapsed ? "sr-only" : "opacity-100",
        )}
      >
        {entry.label}
      </span>
    </button>
  );
  return collapsed ? (
    <Tooltip
      content={
        entry.shortcut ? `${entry.label}  ${entry.shortcut}` : entry.label
      }
      side="right"
    >
      {button}
    </Tooltip>
  ) : (
    button
  );
}

export function Sidebar<R extends string>({
  collapsed,
  items,
  footer,
  current,
  onNavigate,
  setup,
  extras,
}: {
  collapsed: boolean;
  items: NavEntry<R>[];
  footer: NavEntry<string> & { onSelect: () => void; active?: boolean };
  /** Actions above Settings (Invite your team, Get a free month): they open dialogs, not pages. */
  extras?: (NavEntry<string> & { onSelect: () => void })[];
  current: R;
  onNavigate: (r: R) => void;
  /** Shown between the navigation and the footer (the setup card). */
  setup?: ReactNode;
}) {
  return (
    <nav
      aria-label="Main"
      className={cn(
        // Scrolls as a whole when taller than the window (reference), footer included.
        "relative flex shrink-0 flex-col overflow-y-auto overflow-x-hidden px-3 pb-3 transition-[width] duration-[var(--m-duration-base)] ease-out",
        collapsed ? "w-(--m-sidebar-collapsed)" : "w-(--m-sidebar-expanded)",
      )}
    >
      {/* Brand row centred 28 pt below the title bar; first item at 71 pt (reference). */}
      <div
        className={cn(
          "mb-[27px] mt-3 flex h-8 shrink-0 items-center gap-2",
          collapsed ? "justify-center" : "px-2",
        )}
      >
        <MurmurMark className="size-6 shrink-0" />
        {!collapsed && (
          <span className="text-brand font-semibold tracking-[-0.01em] text-fg">
            Murmur
          </span>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {items.map((it) => (
          <NavItem
            key={it.route}
            entry={it}
            active={it.route === current}
            collapsed={collapsed}
            onSelect={() => onNavigate(it.route)}
          />
        ))}
      </div>
      {setup && <div className="mt-3 shrink-0">{setup}</div>}
      <div className="mt-auto flex shrink-0 flex-col gap-1 pt-3">
        <div className="mb-2 h-px bg-hairline" aria-hidden />
        {extras?.map((x) => (
          <NavItem
            key={x.route}
            entry={x}
            active={false}
            collapsed={collapsed}
            onSelect={x.onSelect}
          />
        ))}
        <NavItem
          entry={footer}
          active={Boolean(footer.active)}
          collapsed={collapsed}
          onSelect={footer.onSelect}
        />
      </div>
    </nav>
  );
}

const APPEARANCE_ICON: Record<Settings["appearance"], ReactNode> = {
  system: <Monitor className="size-[18px] stroke-[1.75]" aria-hidden />,
  light: <Sun className="size-[18px] stroke-[1.75]" aria-hidden />,
  dark: <Moon className="size-[18px] stroke-[1.75]" aria-hidden />,
};

/**
 * 52 pt draggable title bar: room for the traffic lights, sidebar toggle, and window utilities.
 * The traffic lights end at x = 79 pt (16 pt buttons on a 23 pt pitch, measured with
 * `npm run capture`); starting the toggle at 92 pt leaves a 13 pt gap so it never reads as a
 * fourth window button.
 */
export function TitleBar({
  collapsed,
  canCollapse,
  onToggleSidebar,
  appearance,
  onAppearance,
  account,
}: {
  collapsed: boolean;
  canCollapse: boolean;
  onToggleSidebar: () => void;
  appearance: Settings["appearance"];
  onAppearance: (a: Settings["appearance"]) => void;
  /** The account button, right of the appearance menu. */
  account?: ReactNode;
}) {
  return (
    // Toggle centred at x 108 pt and the right-hand icon at x 1324 pt, as in the reference.
    <header className="drag flex h-(--m-titlebar-h) shrink-0 items-center pl-[90px] pr-2">
      <IconButton
        label={collapsed ? "Show sidebar (⌃⌘S)" : "Hide sidebar (⌃⌘S)"}
        icon={<PanelLeft className="size-5 stroke-[1.75]" aria-hidden />}
        onClick={onToggleSidebar}
        disabled={!canCollapse}
      />
      <div className="ml-auto flex items-center gap-1">
        <Menu>
          <MenuTrigger asChild>
            <IconButton label="Appearance" icon={APPEARANCE_ICON[appearance]} />
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>Appearance</MenuLabel>
            <MenuRadioGroup
              value={appearance}
              onValueChange={(v) => onAppearance(v as Settings["appearance"])}
            >
              <MenuRadioItem value="system" icon={APPEARANCE_ICON.system}>
                Match macOS
              </MenuRadioItem>
              <MenuRadioItem value="light" icon={APPEARANCE_ICON.light}>
                Light
              </MenuRadioItem>
              <MenuRadioItem value="dark" icon={APPEARANCE_ICON.dark}>
                Dark
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        {account}
      </div>
    </header>
  );
}

/** Page title: Figtree 24 pt semibold (reference), optional description and actions. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    // Without a description the title and its action share the top edge (reference: both at
    // y 93 pt); with one, the action sits at the bottom of the block.
    <div
      className={cn(
        // 45 pt to the next row: the reference's tab row (Dictionary, Snippets) sits at y 174 pt.
        "mb-[45px] flex gap-4",
        description ? "items-end" : "items-start",
      )}
    >
      <div className="min-w-0 flex-1">
        <h1 className="text-title font-semibold text-fg">{title}</h1>
        {description && (
          <p className="mt-1 text-ui text-fg-secondary">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/** Window layout: title bar over (sidebar | rounded sheet). The sheet scrolls; the chrome never does. */
export function AppShell({
  titleBar,
  sidebar,
  children,
  pageKey,
  wide = false,
  bleed = false,
}: {
  titleBar: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  pageKey: string;
  /** Full sheet width (Dictation: list plus totals column) instead of the 800 pt column. */
  wide?: boolean;
  /** The page lays out the whole sheet itself (Notetaker: main column plus a right column). */
  bleed?: boolean;
}) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      {titleBar}
      <div className="flex min-h-0 flex-1">
        {sidebar}
        <main
          id="main"
          // `relative` makes the sheet the containing block of absolutely positioned descendants (the
          // sr-only spans in History rows): otherwise they escape its clipping and make the document scroll.
          // A real border (not a shadow) so scrolled content never covers the sheet edge.
          // The scrollbar gutter is reserved on both sides (10 pt each, see styles.css), so a page
          // that starts scrolling doesn't shift its centred column; padding is 40 pt overall.
          className="relative mb-(--m-sheet-inset) mr-(--m-sheet-inset) min-w-0 flex-1 overflow-y-auto rounded-sheet border border-hairline bg-sheet [scrollbar-gutter:stable_both-edges]"
          tabIndex={-1}
        >
          <div
            key={pageKey}
            className={cn(
              "mx-auto w-full animate-page-in",
              bleed ? "min-h-full" : "px-[30px] pb-12 pt-10 max-[900px]:px-3.5",
              !wide && !bleed && "max-w-(--m-content-max)",
            )}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
