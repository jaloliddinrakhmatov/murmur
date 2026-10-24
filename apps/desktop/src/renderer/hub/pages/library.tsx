// Shared layout for the Dictionary and Snippets screens: a full list loaded once and filtered
// locally (Unicode-aware search, see model/library.ts), a toolbar, the list panel and states.
import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertCircle, Pencil, Trash2 } from "lucide-react";
import { hub } from "../bridge.ts";
import {
  Button,
  IconButton,
  InlineAlert,
  SearchToggle,
  type SearchToggleHandle,
  ListGroup,
  Skeleton,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";

/** Loads a library list and reloads it whenever the dictionary or snippets change anywhere. */
/** A page banner's “×”: remembered per window (a display preference, not a setting). */
export function useDismissed(banner: string): [boolean, () => void] {
  const key = `murmur.banner.${banner}.dismissed`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return [
    dismissed,
    () => {
      setDismissed(true);
      try {
        localStorage.setItem(key, "1");
      } catch {
        // Storage unavailable: dismissed for this session only.
      }
    },
  ];
}

export function useLibraryList<T>(fetch: () => Promise<T[]>) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      fetch()
        .then((r) => {
          setRows(r);
          setError(null);
        })
        .catch((e) => setError(ipcErrorMessage(e))),
    [fetch],
  );
  useEffect(() => {
    void load();
    return hub.onLibraryChanged(() => void load());
  }, [load]);
  return { rows, setRows, error, reload: load };
}

export function LibraryToolbar({
  query,
  onQuery,
  searchRef,
  placeholder,
  label,
  count,
  extra,
  sort,
}: {
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<SearchToggleHandle | null>;
  placeholder: string;
  label: string;
  count: string | null;
  extra?: ReactNode;
  /** The sort menu (before search, as in the reference toolbar). */
  sort?: ReactNode;
}) {
  // The reference's tab row: a 40 pt row over a hairline, tools on the right. Murmur has one
  // list (no team tabs), so the left side holds the count.
  return (
    <div className="mb-6 flex h-10 items-center gap-1 border-b border-hairline">
      <span
        className="mr-auto shrink-0 text-ui font-medium text-fg"
        aria-live="polite"
      >
        {count}
      </span>
      {sort}
      <SearchToggle
        ref={searchRef}
        value={query}
        onValueChange={onQuery}
        placeholder={placeholder}
        label={label}
      />
      {extra}
    </div>
  );
}

export function ListPanel({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return <ListGroup label={label}>{children}</ListGroup>;
}

export function ListSkeleton() {
  return (
    <div
      className="divide-y divide-hairline overflow-hidden rounded-list border border-hairline bg-sheet"
      aria-busy="true"
      aria-label="Loading"
    >
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-3">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full bg-surface-active" />
        </div>
      ))}
    </div>
  );
}

export function LoadError({
  message,
  what,
  onRetry,
}: {
  message: string;
  what: string;
  onRetry: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <InlineAlert
      tone="danger"
      icon={<AlertCircle />}
      action={
        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await onRetry();
            setBusy(false);
          }}
        >
          Try again
        </Button>
      }
    >
      Couldn't load your {what}: {message}
    </InlineAlert>
  );
}

/** Edit and delete, revealed on row hover or keyboard focus. */
export function RowActions({
  name,
  onEdit,
  onDelete,
}: {
  name: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <IconButton
        size="sm"
        label={`Edit ${name}`}
        icon={<Pencil className="size-3.5" aria-hidden />}
        onClick={onEdit}
      />
      <IconButton
        size="sm"
        label={`Delete ${name}`}
        icon={<Trash2 className="size-3.5" aria-hidden />}
        onClick={onDelete}
      />
    </>
  );
}

/** Small print under a list: how the feature behaves. */
export function ListNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 max-w-[68ch] px-1 text-caption text-fg-secondary">
      {children}
    </p>
  );
}
