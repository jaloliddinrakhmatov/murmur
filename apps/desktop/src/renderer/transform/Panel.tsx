// The Transform panel (Stage 9C). It only renders what the main process decided and reports
// button presses: the panel can't take keyboard focus (the app you selected text in keeps it),
// so Esc is a global key while it is open, and every action is a button.
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  Info,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import type { PanelAction, PanelState } from "../../shared/transforms.ts";
import { Button, cn } from "../hub/ui/index.ts";
import { MurmurMark } from "../hub/shell/shell.tsx";

declare global {
  interface Window {
    transformPanel: {
      state(): Promise<PanelState>;
      onState(cb: (s: PanelState) => void): () => void;
      act(action: PanelAction): void;
    };
  }
}
const bridge = window.transformPanel;
const act = (a: PanelAction) => bridge.act(a);

export function Panel() {
  const [state, setState] = useState<PanelState>({ kind: "hidden" });
  useEffect(() => {
    void bridge.state().then(setState);
    return bridge.onState(setState);
  }, []);
  if (state.kind === "hidden") return <div className="h-screen bg-canvas" />;
  const title =
    state.kind === "done"
      ? state.title
      : state.kind === "notice"
        ? state.title
        : state.name;
  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-canvas text-fg"
      // The panel is announced as a dialog for screen readers; it is not modal.
      role="dialog"
      aria-labelledby="transform-title"
    >
      <header className="drag flex h-11 shrink-0 items-center gap-2 px-4">
        <MurmurMark className="size-5 shrink-0" />
        <h1
          id="transform-title"
          className="min-w-0 flex-1 truncate text-ui font-semibold"
        >
          {title}
        </h1>
        <span className="text-caption text-fg-secondary">Esc to close</span>
        <button
          type="button"
          aria-label="Close"
          onClick={() => act("close")}
          className="no-drag flex size-7 items-center justify-center rounded-md hover:bg-surface-hover"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
        <Body state={state} />
      </div>
    </div>
  );
}

function Body({ state }: { state: Exclude<PanelState, { kind: "hidden" }> }) {
  switch (state.kind) {
    case "notice":
      return (
        <>
          <Message tone={state.tone === "error" ? "error" : "info"}>
            {state.message}
          </Message>
          <Footer>
            {state.fix === "ai" && (
              <Button onClick={() => act("openAiSettings")}>
                Open AI settings
              </Button>
            )}
            {state.fix === "accessibility" && (
              <Button onClick={() => act("openAccessibility")}>
                Allow Accessibility…
              </Button>
            )}
            {state.clipboard && (
              <Button variant="primary" onClick={() => act("useClipboard")}>
                Use copied text
              </Button>
            )}
            {!state.clipboard && !state.fix && (
              <Button variant="primary" onClick={() => act("close")}>
                OK
              </Button>
            )}
          </Footer>
        </>
      );
    case "consent":
      return (
        <>
          <Message tone="info">
            Transforms send the text you choose ({state.chars.toLocaleString()}{" "}
            characters now) to {state.service}, the AI service in Settings → AI
            cleanup, and only when you use one. Nothing is replaced until you
            choose Replace.
          </Message>
          <Footer>
            <Button onClick={() => act("close")}>Cancel</Button>
            <Button variant="primary" onClick={() => act("allow")}>
              Allow {state.service}
            </Button>
          </Footer>
        </>
      );
    case "working":
      return (
        <>
          <Texts before={state.before} after={null} />
          <p
            role="status"
            className="flex items-center gap-2 text-caption text-fg-secondary"
          >
            <Sparkles
              className="size-3.5 motion-safe:animate-pulse"
              aria-hidden
            />
            Sending to {state.service}…
          </p>
          <Footer>
            <Button onClick={() => act("close")}>Cancel</Button>
          </Footer>
        </>
      );
    case "review":
      return (
        <>
          <Texts before={state.before} after={state.after} />
          {state.notice ? (
            <Message tone="error">{state.notice}</Message>
          ) : (
            <p className="text-caption text-fg-secondary">
              {state.past
                ? "Your last Transform."
                : state.canReplace
                  ? `Replace changes the selected text in ${state.appName ?? "the app"}. Nothing has changed yet.`
                  : "Copy the result to use it. Nothing has changed."}
            </p>
          )}
          <Footer>
            {!state.past && (
              <Button icon={<RotateCcw />} onClick={() => act("retry")}>
                Retry
              </Button>
            )}
            <Button
              icon={<Copy />}
              variant={state.canReplace ? "secondary" : "primary"}
              onClick={() => act("copy")}
            >
              Copy result
            </Button>
            {state.canReplace && (
              <Button variant="primary" onClick={() => act("replace")}>
                Replace
              </Button>
            )}
          </Footer>
        </>
      );
    case "error":
      return (
        <>
          <Texts before={state.before} after={null} />
          <Message tone="error">{state.message}</Message>
          <Footer>
            <Button onClick={() => act("close")}>Close</Button>
            {state.canRetry && (
              <Button
                variant="primary"
                icon={<RotateCcw />}
                onClick={() => act("retry")}
              >
                Retry
              </Button>
            )}
          </Footer>
        </>
      );
    case "done":
      return (
        <>
          <Message tone={state.tone}>{state.message}</Message>
          <Footer>
            <Button variant="primary" onClick={() => act("close")}>
              Done
            </Button>
          </Footer>
        </>
      );
  }
}

function Texts({ before, after }: { before: string; after: string | null }) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-2 gap-2">
      <section aria-label="Before" className="flex min-h-0 flex-col">
        <h2 className="mb-1 text-caption font-medium text-fg-secondary">
          Before
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md bg-sheet p-2.5 text-ui shadow-[inset_0_0_0_1px_var(--m-hairline)]">
          {before}
        </div>
      </section>
      <section
        aria-label="After"
        aria-busy={after === null}
        className="flex min-h-0 flex-col"
      >
        <h2 className="mb-1 text-caption font-medium text-fg-secondary">
          After
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md bg-accent-faint p-2.5 text-ui">
          {after ?? <span className="text-fg-secondary">…</span>}
        </div>
      </section>
    </div>
  );
}

function Message({
  tone,
  children,
}: {
  tone: "info" | "error" | "success";
  children: ReactNode;
}) {
  const Icon =
    tone === "error" ? AlertCircle : tone === "success" ? CheckCircle2 : Info;
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2 rounded-md p-3 text-ui",
        tone === "error"
          ? "bg-danger-soft text-fg"
          : tone === "success"
            ? "bg-success-soft text-fg"
            : "bg-surface text-fg",
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error"
            ? "text-danger"
            : tone === "success"
              ? "text-success"
              : "text-fg-secondary",
        )}
        aria-hidden
      />
      <span>{children}</span>
    </p>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div className="mt-auto flex flex-wrap justify-end gap-2 pt-1">
      {children}
    </div>
  );
}
