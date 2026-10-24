// One Transform at a time (Stage 9C): read the selection, ask the AI, show the result, and
// replace the selection only when the person accepts — after checking it is still the same
// app, the same field and the same selected text, never a password field, exactly once, and
// confirming afterwards where the app reports its cursor. Everything else (app switched,
// selection changed, no Accessibility, an app that doesn't share its selection) ends in Copy.
import type { InsertOutcome, TargetSnapshot } from "../core/types.ts";
import {
  TRANSFORM_TEXT_MAX,
  type PanelAction,
  type PanelState,
} from "../../shared/transforms.ts";
import { AiCancelled, type AiStatus } from "./service.ts";
import {
  CODE_EDITOR_APPS,
  PASSWORD_MANAGER_APPS,
  TERMINAL_APPS,
} from "../../shared/sensitive-apps.ts";

export interface Selection {
  ok: boolean;
  error?: string;
  pid?: number;
  isSecure: boolean;
  text?: string;
  rangeLocation?: number;
  rangeLength?: number;
  /** The app lets the selection be changed (not a terminal's output or a read-only view). */
  editable?: boolean;
  /** Identifies the field (not its content). */
  elementKey?: string;
}

/**
 * Terminals: a paste there runs at the shell prompt, so their selections are offered for Copy
 * only, whatever Accessibility says.
 */
const NO_REPLACE_APPS = TERMINAL_APPS;

export interface SessionDeps {
  ownPid: number;
  accessibilityGranted: () => boolean;
  /** Secure Event Input (a password prompt has the keyboard): nothing is read then. */
  secureInput: () => boolean;
  readSelection: () => Selection;
  /**
   * For apps that don't share their selection: copies it (⌘C) and restores the clipboard. The
   * native side re-checks the app in front and refuses password input.
   */
  copySelection: (
    pid: number,
  ) => Promise<{ ok: boolean; text?: string; reason?: string }>;
  frontmost: () => { pid: number; bundleId?: string; name?: string } | null;
  /** Read only when the person presses "Use copied text". */
  clipboardRead: () => Promise<string | null>;
  copy: (text: string) => Promise<boolean>;
  /** The dictation inserter's paste (clipboard + ⌘V, restored afterwards). */
  paste: (text: string, target: TargetSnapshot) => Promise<InsertOutcome>;
  transforms: {
    get(input: { id: string }): { id: string; name: string } | null;
    aiStatus(): Promise<AiStatus>;
    run(input: unknown): Promise<{ text: string; name: string }>;
    cancel(requestId: string): boolean;
  };
  allowAi: () => void;
  panel: { show(state: PanelState): void; hide(): void };
  /** Scratchpad handles a Transform itself when its window is in front. */
  noteWindow: { focused(): boolean; transform(transformId: string): void };
  openAiSettings: () => void;
  openAccessibility: () => void;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

interface Target {
  pid: number;
  bundleId: string | null;
  appName: string | null;
  rangeLocation: number | null;
  rangeLength: number | null;
  elementKey: string | null;
  /** Replace is offered: an editable field, not a terminal. */
  replaceable: boolean;
}

interface Session {
  requestId: string;
  transformId: string;
  /** Command Mode (Stage E): the spoken instruction, used instead of a saved Transform. */
  instruction: string | null;
  name: string;
  before: string;
  /** Only for a selection read from another app; otherwise the result can only be copied. */
  target: Target | null;
  result: string | null;
  working: boolean;
  replacing: boolean;
  accepted: boolean;
}

/** The selection Command Mode read when its shortcut was pressed. */
export interface CommandSelection {
  text: string;
  target: Target;
}

/** A spoken instruction longer than this is cut (TransformRunSchema's limit). */
const COMMAND_MAX = 500;
/** Command Mode with nothing selected: the spoken words are the request itself. */
const ASK_INSTRUCTION =
  "This is a spoken request, not text to rewrite. Do what it asks or answer it, briefly. Reply with the result only.";

/** How long "view changes" can show the last result; it is kept in memory only. */
const LAST_KEPT_MS = 10 * 60_000;

export class TransformSessions {
  private readonly d: SessionDeps;
  private s: Session | null = null;
  private last: {
    name: string;
    before: string;
    after: string;
    at: number;
  } | null = null;
  private pendingClipboardTransform: string | null = null;
  private lastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SessionDeps) {
    this.d = deps;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }
  private sleep(ms: number) {
    return this.d.sleep?.(ms) ?? new Promise<void>((r) => setTimeout(r, ms));
  }
  private log(event: string, data?: Record<string, unknown>) {
    this.d.log?.(event, data);
  }
  private show(state: PanelState) {
    this.d.panel.show(state);
  }

  get busy(): boolean {
    return Boolean(this.s?.working || this.s?.replacing);
  }

  /** A transform shortcut was pressed: transform the selection in the app in front. */
  async start(transformId: string): Promise<void> {
    if (this.busy) {
      this.log("transform.ignored", { reason: "busy" });
      return;
    }
    const t = this.d.transforms.get({ id: transformId });
    if (!t) return;
    const front = this.d.frontmost();
    if (front?.pid === this.d.ownPid && this.d.noteWindow.focused()) {
      this.d.noteWindow.transform(transformId);
      return;
    }
    this.pendingClipboardTransform = transformId;
    const fallback = { clipboard: true } as const;
    if (front?.pid === this.d.ownPid)
      return this.show({
        kind: "notice",
        tone: "info",
        title: t.name,
        message:
          "Select text in another app, or in Scratchpad, then press the shortcut. Or copy text and use it here.",
        ...fallback,
      });
    if (this.d.secureInput())
      return this.show({
        kind: "notice",
        tone: "error",
        title: t.name,
        message:
          "A password prompt has the keyboard (Secure Input is on), so Murmur doesn't read anything now.",
      });
    if (!this.d.accessibilityGranted())
      return this.show({
        kind: "notice",
        tone: "info",
        title: t.name,
        message:
          "Murmur can't read your selection without Accessibility access. Copy the text (⌘C), then choose Use copied text.",
        fix: "accessibility",
        ...fallback,
      });
    const sel = this.d.readSelection();
    if (sel.ok && sel.isSecure)
      return this.show({
        kind: "notice",
        tone: "error",
        title: t.name,
        message: "That's a password field. Murmur doesn't read or change it.",
      });
    const selectFirst = {
      kind: "notice",
      tone: "info",
      title: t.name,
      message:
        "Select the text to transform first, then press the shortcut again.",
      ...fallback,
    } as const;
    // The read worked in the right app but found nothing selected.
    const axEmpty =
      sel.ok && (!front || sel.pid === front.pid) && !sel.text?.trim();
    let text = sel.text;
    let target: Target | null = null;
    let source: "ax" | "copy" = "ax";
    if (!sel.ok || (front && sel.pid !== front.pid) || axEmpty) {
      // The app doesn't share its selection (Telegram, some Electron and web views): copy it.
      // Never in a password manager (Secure Input and Accessibility were checked above). With
      // nothing selected, an editor's ⌘C would copy the whole line, so none there.
      const bundleId = front?.bundleId ?? "";
      const mayCopy =
        front !== null &&
        !PASSWORD_MANAGER_APPS.test(bundleId) &&
        !(axEmpty && CODE_EDITOR_APPS.test(bundleId));
      if (front && mayCopy) {
        const copied = await this.d.copySelection(front.pid);
        this.log("transform.copy", {
          ok: copied.ok,
          reason: copied.reason ?? null,
          chars: copied.text?.length ?? 0,
        });
        if (copied.ok && copied.text?.trim()) {
          text = copied.text;
          source = "copy";
          // The range can't be verified, so the result is offered for Copy, not Replace.
          target = {
            pid: front.pid,
            bundleId: front.bundleId ?? null,
            appName: front.name ?? null,
            rangeLocation: null,
            rangeLength: null,
            elementKey: null,
            replaceable: false,
          };
        } else if (copied.reason === "secure-input")
          return this.show({
            kind: "notice",
            tone: "error",
            title: t.name,
            message:
              "A password prompt has the keyboard (Secure Input is on), so Murmur doesn't read anything now.",
          });
        else if (copied.reason === "secure-text-field")
          return this.show({
            kind: "notice",
            tone: "error",
            title: t.name,
            message:
              "That's a password field. Murmur doesn't read or change it.",
          });
        else if (copied.reason === "too-long")
          return this.show({
            kind: "notice",
            tone: "error",
            title: t.name,
            message: `That's too long for one Transform. Select up to ${TRANSFORM_TEXT_MAX.toLocaleString("en-US")} characters.`,
          });
        else if (axEmpty) return this.show(selectFirst);
        else
          return this.show({
            kind: "notice",
            tone: "info",
            title: t.name,
            message: `Couldn't copy your selection from ${front.name ?? "this app"}. Copy it (⌘C), then choose Use copied text.`,
            ...fallback,
          });
      } else if (axEmpty) return this.show(selectFirst);
      else
        return this.show({
          kind: "notice",
          tone: "info",
          title: t.name,
          message: `${front?.name ?? "This app"} doesn't share its selection with Murmur. Copy the text (⌘C), then choose Use copied text.`,
          ...fallback,
        });
    }
    if (!text?.trim()) return this.show(selectFirst);
    this.log("transform.selection", { source, chars: text.length });
    target ??= {
      pid: sel.pid ?? front!.pid,
      bundleId: front?.bundleId ?? null,
      appName: front?.name ?? null,
      rangeLocation: sel.rangeLocation ?? null,
      rangeLength: sel.rangeLength ?? null,
      elementKey: sel.elementKey ?? null,
      replaceable:
        sel.editable === true && !NO_REPLACE_APPS.test(front?.bundleId ?? ""),
    };
    await this.begin(transformId, t.name, text, target);
  }

  /**
   * Command Mode (Stage E): what is selected in the app in front, read when the shortcut is
   * pressed (before speaking). Null when nothing usable is selected, or it can't be read safely:
   * Murmur in front, Secure Input on, no Accessibility, a password field.
   */
  captureSelection(): CommandSelection | null {
    const front = this.d.frontmost();
    if (!front || front.pid === this.d.ownPid) return null;
    if (this.d.secureInput() || !this.d.accessibilityGranted()) return null;
    const sel = this.d.readSelection();
    if (!sel.ok || sel.isSecure || sel.pid !== front.pid || !sel.text?.trim())
      return null;
    return {
      text: sel.text,
      target: {
        pid: sel.pid ?? front.pid,
        bundleId: front.bundleId ?? null,
        appName: front.name ?? null,
        rangeLocation: sel.rangeLocation ?? null,
        rangeLength: sel.rangeLength ?? null,
        elementKey: sel.elementKey ?? null,
        replaceable:
          sel.editable === true && !NO_REPLACE_APPS.test(front.bundleId ?? ""),
      },
    };
  }

  /**
   * Command Mode: the spoken instruction applied to the selection read at the press (Replace
   * offered as for a Transform), or, with nothing selected, answered on its own (Copy only).
   */
  async startCommand(
    spoken: string,
    selection: CommandSelection | null,
  ): Promise<void> {
    if (this.busy) return;
    const instruction = spoken.trim().slice(0, COMMAND_MAX);
    if (!instruction) return;
    const title = `“${instruction.length > 48 ? `${instruction.slice(0, 47)}…` : instruction}”`;
    if (selection)
      await this.begin(
        "",
        title,
        selection.text,
        selection.target,
        instruction,
      );
    else await this.begin("", "Ask Murmur", instruction, null, ASK_INSTRUCTION);
  }

  /** Transform given text (History, or the clipboard): the result can be copied, not replaced. */
  async startWithText(transformId: string, text: string): Promise<void> {
    if (this.busy) return;
    const t = this.d.transforms.get({ id: transformId });
    if (!t) return;
    await this.begin(transformId, t.name, text, null);
  }

  private async begin(
    transformId: string,
    name: string,
    text: string,
    target: Target | null,
    instruction: string | null = null,
  ) {
    if (text.length > TRANSFORM_TEXT_MAX)
      return this.show({
        kind: "notice",
        tone: "error",
        title: name,
        message: `That's too long for one Transform. Select up to ${TRANSFORM_TEXT_MAX.toLocaleString("en-US")} characters.`,
      });
    this.s = {
      requestId: this.d.newId(),
      transformId,
      instruction,
      name,
      before: text,
      target,
      result: null,
      working: false,
      replacing: false,
      accepted: false,
    };
    const status = await this.d.transforms.aiStatus();
    if (status.ready !== null)
      return this.show({
        kind: "notice",
        tone: "error",
        title: name,
        message: `Set up ${status.service} in Settings → AI cleanup to use Transforms. Nothing was sent.`,
        fix: "ai",
      });
    if (!status.consented) {
      this.consentFor = status.provider;
      return this.show({
        kind: "consent",
        name,
        service: status.service,
        chars: text.length,
      });
    }
    await this.run();
  }

  /** The AI service the consent panel named (consent is recorded only for that one). */
  private consentFor: string | null = null;

  private async run(): Promise<void> {
    const s = this.s;
    if (!s || s.working) return;
    s.working = true;
    s.result = null;
    s.requestId = this.d.newId();
    const status = await this.d.transforms.aiStatus();
    // Closed while asking (a slow Keychain, say): nothing is sent.
    if (this.s !== s) {
      s.working = false;
      return;
    }
    this.show({
      kind: "working",
      name: s.name,
      before: s.before,
      service: status.service,
    });
    try {
      const out = await this.d.transforms.run({
        requestId: s.requestId,
        ...(s.instruction
          ? { instruction: s.instruction }
          : { transformId: s.transformId }),
        text: s.before,
      });
      if (this.s !== s) return;
      s.result = out.text;
      this.last = {
        name: s.name,
        before: s.before,
        after: out.text,
        at: this.now(),
      };
      // A pasted newline can auto-indent or run in an editor or terminal: Copy only there.
      const multilineRisk =
        s.target?.replaceable === true &&
        /[\r\n]/.test(out.text) &&
        (CODE_EDITOR_APPS.test(s.target.bundleId ?? "") ||
          TERMINAL_APPS.test(s.target.bundleId ?? ""));
      if (multilineRisk && s.target) s.target.replaceable = false;
      this.show({
        kind: "review",
        name: s.name,
        before: s.before,
        after: out.text,
        canReplace: Boolean(s.target?.replaceable),
        appName: s.target?.appName ?? null,
        notice: multilineRisk
          ? `The result has several lines, and pasting them into ${s.target?.appName ?? "this app"} could change or run them. Copy the result instead.`
          : s.target && !s.target.replaceable
            ? `${s.target.appName ?? "This app"} doesn't let Murmur change this text, so Copy the result instead.`
            : undefined,
      });
      this.keepLast();
    } catch (err) {
      if (this.s !== s) return;
      if (err instanceof AiCancelled || (err as Error).name === "AiCancelled") {
        this.close();
        return;
      }
      this.show({
        kind: "error",
        name: s.name,
        before: s.before,
        message: (err as Error).message,
        canRetry: true,
      });
    } finally {
      s.working = false;
    }
  }

  /** The panel's buttons; a failure is shown in the panel, never left unreported. */
  async act(action: PanelAction): Promise<void> {
    try {
      await this.handle(action);
    } catch (err) {
      this.log("transform.failed", { action, error: (err as Error).name });
      this.show({
        kind: "done",
        tone: "error",
        title: "Something went wrong",
        message:
          action === "replace"
            ? "Murmur couldn't finish replacing the text. Check it in the app; Copy the result from History or try again."
            : "Murmur couldn't do that. Try again.",
      });
    }
  }

  private async handle(action: PanelAction): Promise<void> {
    switch (action) {
      case "allow": {
        if (!this.s) return;
        // Consent is for the service the panel named; if Settings changed meanwhile, ask again.
        const status = await this.d.transforms.aiStatus();
        if (status.provider !== this.consentFor) {
          this.consentFor = status.provider;
          return this.show({
            kind: "consent",
            name: this.s.name,
            service: status.service,
            chars: this.s.before.length,
          });
        }
        this.d.allowAi();
        return this.run();
      }
      case "retry":
        return this.run();
      case "replace":
        return this.replace();
      case "copy":
        return this.copyResult();
      case "useClipboard":
        return this.useClipboard();
      case "openAiSettings":
        this.close();
        return this.d.openAiSettings();
      case "openAccessibility":
        this.close();
        return this.d.openAccessibility();
      case "close":
        return this.close();
    }
  }

  close(): void {
    if (this.s?.working) this.d.transforms.cancel(this.s.requestId);
    this.s = null;
    this.d.panel.hide();
  }

  /** Keeps the last result for "view changes" for 10 minutes, in memory only. */
  private keepLast(): void {
    if (this.lastTimer) clearTimeout(this.lastTimer);
    this.lastTimer = setTimeout(() => this.forget(), LAST_KEPT_MS);
    this.lastTimer.unref?.();
  }

  /** Drops the last result (after 10 minutes, on opting out, on quitting). */
  forget(): void {
    if (this.lastTimer) clearTimeout(this.lastTimer);
    this.lastTimer = null;
    this.last = null;
  }

  /** "Transform view changes": the last result again, read-only, with Copy. */
  viewChanges(): void {
    if (this.busy) return;
    if (!this.last || this.now() - this.last.at > LAST_KEPT_MS) {
      this.last = null;
      return this.show({
        kind: "notice",
        tone: "info",
        title: "Transform",
        message: "There's no recent Transform to show.",
      });
    }
    this.s = null;
    this.show({
      kind: "review",
      name: this.last.name,
      before: this.last.before,
      after: this.last.after,
      canReplace: false,
      appName: null,
      past: true,
    });
  }

  private async copyResult(): Promise<void> {
    const after = this.s?.result ?? this.last?.after;
    if (!after) return;
    const ok = await this.d.copy(after);
    this.show(
      ok
        ? {
            kind: "done",
            tone: "success",
            title: "Copied",
            message: "The result is on the clipboard. Paste it with ⌘V.",
          }
        : {
            kind: "done",
            tone: "error",
            title: "Couldn't copy",
            message: "The clipboard didn't take the text. Try again.",
          },
    );
    if (ok && this.s) this.s.accepted = true;
  }

  private async useClipboard(): Promise<void> {
    const id = this.pendingClipboardTransform;
    if (!id) return;
    const text = await this.d.clipboardRead();
    if (!text?.trim())
      return this.show({
        kind: "notice",
        tone: "info",
        title: "Nothing copied",
        message: "Copy the text you want to transform (⌘C) first.",
        clipboard: true,
      });
    const t = this.d.transforms.get({ id });
    if (!t) return;
    await this.begin(id, t.name, text, null);
  }

  private async replace(): Promise<void> {
    const s = this.s;
    if (!s?.result || !s.target?.replaceable || s.accepted || s.replacing)
      return;
    s.replacing = true;
    try {
      const target = s.target;
      const keepReview = (notice: string) =>
        this.show({
          kind: "review",
          name: s.name,
          before: s.before,
          after: s.result!,
          canReplace: false,
          appName: target.appName,
          notice,
        });
      // 1. Still the same app in front.
      const front = this.d.frontmost();
      if (front?.pid !== target.pid)
        return keepReview(
          `${target.appName ?? "The app"} isn't in front any more, so nothing was replaced. Copy the result instead.`,
        );
      // 2. Same field, same selected text, not a password field.
      const sel = this.d.readSelection();
      // Same field and, where the app reported one, exactly the same range.
      const sameField =
        target.elementKey === null || sel.elementKey === target.elementKey;
      const sameRange =
        target.rangeLocation === null ||
        (sel.rangeLocation === target.rangeLocation &&
          sel.rangeLength === target.rangeLength);
      if (sel.ok && sel.isSecure)
        return keepReview(
          "The cursor is in a password field now, so nothing was replaced.",
        );
      if (
        !sel.ok ||
        sel.pid !== target.pid ||
        sel.text !== s.before ||
        !sameField ||
        !sameRange
      )
        return keepReview(
          "The selection changed, so nothing was replaced. Copy the result instead.",
        );
      // 3. Exactly once.
      s.accepted = true;
      const outcome = await this.d.paste(s.result, {
        appBundleId: target.bundleId,
        appName: target.appName,
        pid: target.pid,
        secure: false,
        takenAt: this.now(),
      });
      this.log("transform.replace", {
        strategy: outcome.strategy,
        reason: outcome.reason,
      });
      if (outcome.strategy === "clipboard-paste") {
        // 4. Confirm where the app reports its cursor: right after the new text, nothing selected.
        await this.sleep(250);
        const after = this.d.readSelection();
        const verified =
          target.rangeLocation !== null &&
          after.ok &&
          after.pid === target.pid &&
          after.rangeLocation === target.rangeLocation + s.result.length &&
          after.rangeLength === 0;
        // The selection still exactly as before: the paste didn't change anything.
        const unchanged =
          !verified &&
          after.ok &&
          after.pid === target.pid &&
          after.text === s.before &&
          (target.rangeLocation === null ||
            after.rangeLocation === target.rangeLocation);
        this.log("transform.replaced", { verified, unchanged });
        if (unchanged)
          return this.show({
            kind: "done",
            tone: "error",
            title: "Nothing changed",
            message: `${target.appName ?? "The app"} didn't take the pasted text. The result is still in this panel's history: press the view-changes shortcut, or run the Transform again and Copy.`,
          });
        return this.show(
          verified
            ? {
                kind: "done",
                tone: "success",
                title: "Replaced",
                message: `Replaced in ${target.appName ?? "the app"}. To undo, press ⌘Z there.`,
              }
            : {
                kind: "done",
                tone: "info",
                title: "Pasted",
                message: `Murmur sent the result to ${target.appName ?? "the app"} with ⌘V, but the app doesn't report enough to confirm it. Check the text; ⌘Z there undoes it.`,
              },
        );
      }
      if (outcome.strategy === "clipboard-only")
        return this.show({
          kind: "done",
          tone: "info",
          title: "Copied instead",
          message:
            outcome.reason === "no-post-event-permission"
              ? "Murmur isn't allowed to paste. The result is on the clipboard; paste it with ⌘V."
              : "Murmur couldn't paste here. The result is on the clipboard; paste it with ⌘V.",
        });
      s.accepted = false;
      return keepReview(
        outcome.reason === "secure-field"
          ? "That's a password field, so nothing was replaced."
          : "Murmur couldn't replace the text. Copy the result instead.",
      );
    } finally {
      s.replacing = false;
    }
  }
}
