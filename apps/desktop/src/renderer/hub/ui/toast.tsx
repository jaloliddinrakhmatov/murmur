import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "./cn.ts";

type Tone = "info" | "success" | "error";
interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}

const ToastContext = createContext<
  ((t: Omit<ToastItem, "id" | "tone"> & { tone?: Tone }) => void) | null
>(null);

const ICONS: Record<Tone, ReactNode> = {
  info: <Info className="size-4 text-fg-secondary" aria-hidden />,
  success: <CheckCircle2 className="size-4 text-success" aria-hidden />,
  error: <CircleAlert className="size-4 text-danger" aria-hidden />,
};

const DURATION_MS: Record<Tone, number> = {
  info: 3500,
  success: 3500,
  error: 6000,
};

/** Anything Radix stacks above the page: dialogs, sheets, menus, popovers. */
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]';

/**
 * Bottom-right transient notices for completed actions (copied, exported, deleted).
 *
 * Not a Radix layer on purpose (Stage 9B): a Radix toast joins the dismissable-layer stack, so
 * one that appeared while Settings was open took the next Esc and Settings stayed open. Esc
 * order is now: an open dialog or menu (Radix), then the focused control's own use of Esc
 * (clearing a search, cancelling a recording; those stop the event), then the newest notice.
 * Notices are announced through polite (errors: assertive) live regions that are always present.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback(
    (t: Omit<ToastItem, "id" | "tone"> & { tone?: Tone }) => {
      setItems((list) => [
        ...list.slice(-2),
        {
          id: Date.now() + Math.random(),
          tone: t.tone ?? "info",
          title: t.title,
          description: t.description,
        },
      ]);
    },
    [],
  );
  const dismiss = useCallback(
    (id: number) => setItems((list) => list.filter((x) => x.id !== id)),
    [],
  );

  const latest = useRef<ToastItem[]>(items);
  latest.current = items;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const newest = latest.current.at(-1);
      if (!newest || document.querySelector(OVERLAY)) return;
      e.preventDefault();
      e.stopPropagation();
      dismiss(newest.id);
    };
    // Bubble phase on window: only an Esc that no dialog, menu or control used reaches here.
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);

  const list = (tones: Tone[]) =>
    items
      .filter((t) => tones.includes(t.tone))
      .map((t) => <Toast key={t.id} item={t} onDismiss={dismiss} />);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2">
        <div role="status" aria-live="polite" className="contents">
          {list(["info", "success"])}
        </div>
        <div role="alert" aria-live="assertive" className="contents">
          {list(["error"])}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function Toast({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDismiss(item.id), DURATION_MS[item.tone]);
    return () => clearTimeout(t);
  }, [paused, item, onDismiss]);
  return (
    <div
      data-toast={item.tone}
      // Hovering or focusing a notice keeps it until the pointer or focus leaves.
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={cn(
        "pointer-events-auto flex w-80 animate-toast-in items-start gap-2.5 rounded-xl bg-modal p-3 shadow-popover",
      )}
    >
      <span className="mt-px">{ICONS[item.tone]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-ui font-medium text-fg">{item.title}</p>
        {item.description && (
          <p className="mt-0.5 break-words text-caption text-fg-secondary">
            {item.description}
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(item.id)}
        className="flex size-5 items-center justify-center rounded text-fg-tertiary hover:bg-surface-hover hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
