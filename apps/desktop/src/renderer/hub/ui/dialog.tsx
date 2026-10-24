import * as RadixDialog from "@radix-ui/react-dialog";
import { AlertCircle, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "./button.tsx";
import { cn } from "./cn.ts";
import { ipcErrorMessage } from "../model/errors.ts";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

const SIZES = {
  sm: "w-[min(400px,calc(100vw-48px))]",
  md: "w-[min(520px,calc(100vw-48px))]",
  lg: "w-[min(720px,calc(100vw-48px))]",
};

/**
 * Returns focus to whatever opened a dialog. Radix only restores focus to a `Dialog.Trigger`;
 * dialogs opened by an ordinary button or a shortcut would otherwise leave focus on <body>.
 * The opener is read when the dialog mounts, before focus moves into it.
 */
export function useRestoreFocus(handlers: {
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      handlers.onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      handlers.onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (opener.current?.isConnected) opener.current.focus();
    },
  };
}

/**
 * Modal panel: header and footer stay put, `DialogBody` scrolls, and the whole dialog never
 * exceeds the window (it fits a 780 × 560 window). Radix traps focus, closes on Esc and returns
 * focus to the element that opened it.
 */
export function DialogContent({
  size = "md",
  bare = false,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: {
  /** "custom": the caller's className sets the size. */
  size?: keyof typeof SIZES | "custom";
  /** No padding: the content draws its own panels edge to edge (split editors). */
  bare?: boolean;
  className?: string;
  children: ReactNode;
} & RadixDialog.DialogContentProps) {
  const focus = useRestoreFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <RadixDialog.Portal>
      {/* z-50, like the Settings sheet: a dialog opened over Settings dims it too (reference). */}
      <RadixDialog.Overlay className="fixed inset-0 z-50 animate-overlay-in bg-overlay" />
      <RadixDialog.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-modal shadow-dialog outline-none",
          !bare && "p-6",
          "animate-dialog-in",
          size !== "custom" && SIZES[size],
          className,
        )}
        {...props}
        {...focus}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/**
 * Side sheet: a full-height panel inset from the window's right edge, for details that keep the
 * list in view. Same focus behavior as DialogContent; use DialogHeader / DialogBody /
 * DialogFooter inside.
 */
export function SheetContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: {
  className?: string;
  children: ReactNode;
} & RadixDialog.DialogContentProps) {
  const focus = useRestoreFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className="fixed inset-0 z-40 animate-overlay-in bg-overlay" />
      <RadixDialog.Content
        className={cn(
          "fixed bottom-2 right-2 top-2 z-50 flex w-[min(480px,calc(100vw-16px))] animate-sheet-in flex-col overflow-hidden rounded-xl bg-modal p-6 shadow-dialog outline-none",
          className,
        )}
        {...props}
        {...focus}
      >
        {children}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

/** The scrolling middle of a dialog (form fields, long text). */
export function DialogBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "-mx-6 min-h-0 flex-1 overflow-y-auto px-6 py-0.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DialogHeader({
  title,
  description,
  onCloseLabel = "Close",
}: {
  title: ReactNode;
  description?: ReactNode;
  onCloseLabel?: string;
}) {
  return (
    <div className="mb-5 flex shrink-0 items-start gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <RadixDialog.Title className="text-heading font-semibold text-fg">
          {title}
        </RadixDialog.Title>
        {description ? (
          <RadixDialog.Description className="text-ui text-fg-secondary">
            {description}
          </RadixDialog.Description>
        ) : (
          <RadixDialog.Description className="sr-only">
            {title}
          </RadixDialog.Description>
        )}
      </div>
      <RadixDialog.Close asChild>
        <button
          type="button"
          aria-label={onCloseLabel}
          className="-mr-2 -mt-1 flex size-8 items-center justify-center rounded-md text-fg hover:bg-surface-hover"
        >
          <X className="size-4" aria-hidden />
        </button>
      </RadixDialog.Close>
    </div>
  );
}

export function DialogFooter({
  children,
  start,
}: {
  children: ReactNode;
  /** Left-aligned content, e.g. a character count or a discard prompt. */
  start?: ReactNode;
}) {
  return (
    <div className="mt-6 flex shrink-0 flex-wrap items-center justify-end gap-2">
      {start && <div className="mr-auto min-w-0">{start}</div>}
      {children}
    </div>
  );
}

/** A failed save or delete, shown inside the dialog so nothing is lost. */
export function DialogError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mt-4 flex shrink-0 items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-ui text-fg"
    >
      <AlertCircle className="mt-px size-4 shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  /** Throw to keep the dialog open and show the error. */
  onConfirm: () => void | Promise<void>;
  /** Where focus goes on close when the opener no longer exists (e.g. a deleted row). */
  onCloseAutoFocus?: (event: Event) => void;
}

/** Confirmation for irreversible actions. Focus starts on Cancel. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
  onCloseAutoFocus,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const change = (next: boolean) => {
    if (busy) return;
    setError(null);
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        size="sm"
        role="alertdialog"
        // Not autoFocus: that would move focus before the opener is recorded for restoring.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader title={title} description={description} />
        <DialogError message={error} />
        <DialogFooter>
          <DialogClose asChild>
            <Button ref={cancelRef} disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                setBusy(false);
                onOpenChange(false);
              } catch (e) {
                setBusy(false);
                setError(ipcErrorMessage(e));
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface EditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Unsaved changes: closing asks before discarding them. */
  dirty: boolean;
  canSave: boolean;
  saving: boolean;
  saveLabel: string;
  error: string | null;
  onSubmit: () => void;
  /** Enter pressed while invalid: reveal the errors that wait for a touched field. */
  onInvalidSubmit?: () => void;
  /** Field to focus when the dialog opens (Radix would pick the close button). */
  initialFocus: RefObject<HTMLElement | null>;
  footerStart?: ReactNode;
  children: ReactNode;
}

/**
 * Add/edit form in a dialog. Enter saves (⌘↩ from a multi-line field); Save stays disabled while
 * the form is invalid or saving. Esc, the close button, a click outside or Cancel close it, but
 * with unsaved changes they first ask, so nothing typed is lost by accident.
 */
export function EditorDialog({
  open,
  onOpenChange,
  title,
  description,
  dirty,
  canSave,
  saving,
  saveLabel,
  error,
  onSubmit,
  onInvalidSubmit,
  initialFocus,
  footerStart,
  children,
}: EditorDialogProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) setConfirmDiscard(false);
  }, [open]);
  const asked = useRef(false);
  useEffect(() => {
    if (confirmDiscard) keepRef.current?.focus();
    // Back from "Discard your changes?": continue where editing starts.
    else if (asked.current) initialFocus.current?.focus();
    asked.current = confirmDiscard;
  }, [confirmDiscard, initialFocus]);
  // Esc or the close button while asking means "keep editing".
  const requestClose = () => {
    if (saving) return;
    if (confirmDiscard) setConfirmDiscard(false);
    else if (dirty) setConfirmDiscard(true);
    else onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
    >
      <DialogContent
        size="md"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          initialFocus.current?.focus();
        }}
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (saving || confirmDiscard) return;
            if (canSave) onSubmit();
            else onInvalidSubmit?.();
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.defaultPrevented) return;
            if (e.metaKey && e.target instanceof HTMLTextAreaElement) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            } else if (e.target instanceof HTMLInputElement && !canSave) {
              // Browsers skip implicit submission while Save is disabled; explain instead.
              e.preventDefault();
              onInvalidSubmit?.();
            }
          }}
        >
          <DialogHeader title={title} description={description} />
          <DialogBody>
            <fieldset disabled={saving || confirmDiscard} className="min-w-0">
              {children}
            </fieldset>
          </DialogBody>
          <DialogError message={error} />
          {confirmDiscard ? (
            <DialogFooter
              start={
                <span role="alert" className="text-ui font-medium text-fg">
                  Discard your changes?
                </span>
              }
            >
              <Button ref={keepRef} onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="danger" onClick={() => onOpenChange(false)}>
                Discard
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter start={footerStart}>
              <Button onClick={requestClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!canSave}
                loading={saving}
              >
                {saveLabel}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
