// Transforms (Stage 9C): the saved transforms, their shortcuts, and the one AI path every text
// rewrite takes — Transforms in any app, Scratchpad's AI edits, History's "Transform…". Text is
// sent only on an explicit request, only after the person allowed that AI service, and never
// logged; provider errors are reduced to their status code because they can quote the request.
import {
  SUMMARY_MAX_TOKENS,
  SUMMARY_PROMPT,
  SUMMARY_TEXT_MAX,
} from "@murmur/refine";
import {
  TransformDeleteSchema,
  TransformIdSchema,
  TransformInputSchema,
  TransformPatchSchema,
  TransformRunSchema,
  TransformShortcutSchema,
  transformPrompt,
  type Transform,
} from "../../shared/transforms.ts";
import type { TransformRepo } from "../history/db.ts";

export interface TextService {
  id: string;
  /** null when ready; otherwise why not (no key, local server down…). */
  readiness(): Promise<string | null>;
  generate(
    system: string,
    user: string,
    options: { signal: AbortSignal; maxTokens?: number },
  ): Promise<{ text: string }>;
}

export interface ShortcutStatus {
  combo: string;
  registered: boolean;
  error: string | null;
}

/** The part of CarbonHotkeys Transforms use (main/native/hotkeys.ts). */
export interface TransformHotkeys {
  check(
    combo: string,
    binding: `transform:${string}`,
  ): { normalized: string | null; errors: string[]; warnings: string[] };
  /** Registers every transform shortcut given (and nothing else); returns each one's status. */
  bindTransforms(
    bindings: { id: string; combo: string }[],
  ): Map<string, ShortcutStatus>;
}

export interface TransformDeps {
  transforms: TransformRepo;
  hotkeys: TransformHotkeys;
  newId: () => string;
  optedIn: () => boolean;
  /** The AI cleanup service (Settings → AI cleanup) and its display name and id. */
  ai: () => TextService;
  aiName: () => string;
  aiProvider: () => string;
  aiConsented: () => boolean;
  /** Consent to send meeting transcripts and notes (other people's speech) for summaries. */
  summaryConsented: () => boolean;
  onChange: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
}

export class AiCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "AiCancelled";
  }
}

export interface AiStatus {
  ready: string | null;
  service: string;
  provider: string;
  consented: boolean;
  /** The person agreed to send meeting transcripts to this service (separate consent). */
  summaryConsented: boolean;
}

const AI_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 180_000;
export class TransformService {
  private readonly d: TransformDeps;
  private readonly running = new Map<string, AbortController>();
  private statuses = new Map<string, ShortcutStatus>();

  constructor(deps: TransformDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private log(event: string, data?: Record<string, unknown>): void {
    this.d.log?.(event, data);
  }

  // ---- Saved transforms ------------------------------------------------------------------------

  list(search = ""): (Transform & { status: ShortcutStatus | null })[] {
    return this.d.transforms
      .list(typeof search === "string" ? search.slice(0, 200) : "")
      .map((t) => ({ ...t, status: this.statuses.get(t.id) ?? null }));
  }

  get(input: unknown): Transform | null {
    return this.d.transforms.get(TransformIdSchema.parse(input).id);
  }

  create(input: unknown): Transform {
    const t = TransformInputSchema.parse(input);
    const created = this.d.transforms.create(
      { id: this.d.newId(), ...t },
      this.now(),
    );
    this.d.onChange();
    return created;
  }

  update(input: unknown): Transform {
    const { id, ...patch } = TransformPatchSchema.parse(input);
    const cur = this.d.transforms.get(id);
    if (!cur) throw new Error("This transform no longer exists.");
    if (cur.kind === "custom" && patch.prompt !== undefined && !patch.prompt)
      throw new Error("Describe how it should change your text.");
    const t = this.d.transforms.update(id, patch, this.now());
    this.d.onChange();
    return t;
  }

  delete(input: unknown): boolean {
    const { id } = TransformDeleteSchema.parse(input);
    const deleted = this.d.transforms.delete(id);
    if (deleted) {
      this.syncShortcuts();
      this.d.onChange();
    }
    return deleted;
  }

  resetDefaults(): void {
    this.d.transforms.resetDefaults(this.now());
    this.syncShortcuts();
    this.d.onChange();
  }

  /**
   * Sets (or clears) a transform's shortcut. While Transforms are on, the new combination is
   * registered with macOS first and the old one restored if that fails; while they are off it is
   * checked against Murmur's other shortcuts and saved, to be registered on opting in.
   */
  setShortcut(input: unknown): ShortcutStatus | null {
    const { id, shortcut } = TransformShortcutSchema.parse(input);
    const t = this.d.transforms.get(id);
    if (!t) throw new Error("This transform no longer exists.");
    if (shortcut === null) {
      this.d.transforms.setShortcut(id, null, this.now());
      this.syncShortcuts();
      this.d.onChange();
      return null;
    }
    const check = this.d.hotkeys.check(shortcut, `transform:${id}`);
    if (check.errors.length) throw new Error(check.errors[0]);
    const combo = check.normalized ?? shortcut;
    const previous = t.shortcut;
    this.d.transforms.setShortcut(id, combo, this.now());
    if (this.d.optedIn()) {
      this.syncShortcuts();
      const status = this.statuses.get(id);
      if (!status?.registered) {
        this.d.transforms.setShortcut(id, previous, this.now());
        this.syncShortcuts();
        throw new Error(status?.error ?? "registration failed");
      }
    }
    this.d.onChange();
    return this.statuses.get(id) ?? null;
  }

  /** Registers the shortcuts of every transform while opted in, none otherwise. */
  syncShortcuts(): void {
    const bindings = this.d.optedIn()
      ? this.d.transforms
          .list()
          .flatMap((t) => (t.shortcut ? [{ id: t.id, combo: t.shortcut }] : []))
      : [];
    this.statuses = this.d.hotkeys.bindTransforms(bindings);
  }

  // ---- Running a transform ---------------------------------------------------------------------

  async aiStatus(): Promise<AiStatus> {
    return {
      ready: await this.d.ai().readiness(),
      service: this.d.aiName(),
      provider: this.d.aiProvider(),
      consented: this.d.aiConsented(),
      summaryConsented: this.d.summaryConsented(),
    };
  }

  /**
   * Rewrites `text` with a saved transform or a one-off instruction and returns the result for
   * the person to review; nothing is replaced here. `cancel` with the same request id stops it.
   */
  async run(input: unknown): Promise<{ text: string; name: string }> {
    const req = TransformRunSchema.parse(input);
    let system: string;
    let name: string;
    if (req.transformId) {
      const t = this.d.transforms.get(req.transformId);
      if (!t) throw new Error("This transform no longer exists.");
      system = transformPrompt(t);
      name = t.name;
    } else if (req.instruction) {
      system = transformPrompt({
        kind: "custom",
        prompt: req.instruction,
        rules: null,
      });
      name = "Your change";
    } else throw new Error("Choose a transform.");

    // Registered before anything is awaited, so a cancel at any point stops the request.
    const controller = new AbortController();
    this.running.get(req.requestId)?.abort();
    this.running.set(req.requestId, controller);
    const provider = this.d.ai();
    const notReady = await provider.readiness();
    if (controller.signal.aborted) {
      this.running.delete(req.requestId);
      throw new AiCancelled();
    }
    if (notReady || !this.d.aiConsented()) {
      this.running.delete(req.requestId);
      throw new Error(
        notReady
          ? `Set up ${this.d.aiName()} in Settings → AI cleanup to use Transforms. Nothing was sent.`
          : `Allow Transforms to send text to ${this.d.aiName()} first. Nothing was sent.`,
      );
    }
    const started = this.now();
    const kind = req.transformId ? "saved" : "instruction";
    let out: { text: string };
    try {
      out = await provider.generate(system, req.text, {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(AI_TIMEOUT_MS),
        ]),
        maxTokens: Math.min(8192, Math.ceil(req.text.length / 2) + 512),
      });
    } catch (err) {
      if (controller.signal.aborted) {
        this.log("transform.run", { kind, cancelled: true });
        throw new AiCancelled();
      }
      this.log("transform.run", { kind, failed: (err as Error).name });
      throw new Error(this.providerMessage(err as Error));
    } finally {
      if (this.running.get(req.requestId) === controller)
        this.running.delete(req.requestId);
    }
    if (controller.signal.aborted) throw new AiCancelled();
    const text = out.text.trim();
    this.log("transform.run", {
      kind,
      chars: req.text.length,
      outChars: text.length,
      ms: this.now() - started,
      ok: Boolean(text),
    });
    if (!text)
      throw new Error(`${this.d.aiName()} returned nothing. Try again.`);
    return { text, name };
  }

  /**
   * Notetaker (Stage 9D-2): a meeting summary from its transcript and notes, on request, with the
   * same readiness, consent, cancellation and error handling as a Transform.
   */
  async summarize(requestId: string, text: string): Promise<string> {
    if (text.length > SUMMARY_TEXT_MAX)
      throw new Error(
        "This meeting is too long to summarize in one request. Nothing was sent.",
      );
    const controller = new AbortController();
    this.running.get(requestId)?.abort();
    this.running.set(requestId, controller);
    try {
      const provider = this.d.ai();
      const notReady = await provider.readiness();
      if (controller.signal.aborted) throw new AiCancelled();
      if (notReady)
        throw new Error(
          `Set up ${this.d.aiName()} in Settings → AI cleanup to summarize meetings. Nothing was sent.`,
        );
      if (!this.d.summaryConsented())
        throw new Error(
          `Allow sending meeting transcripts and notes to ${this.d.aiName()} first. Nothing was sent.`,
        );
      const started = this.now();
      let out: { text: string };
      try {
        out = await provider.generate(SUMMARY_PROMPT, text, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
          ]),
          maxTokens: SUMMARY_MAX_TOKENS,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new AiCancelled();
        this.log("meeting.summary.run", { failed: (err as Error).name });
        throw new Error(this.providerMessage(err as Error));
      }
      if (controller.signal.aborted) throw new AiCancelled();
      const summary = out.text.trim();
      this.log("meeting.summary.run", {
        chars: text.length,
        outChars: summary.length,
        ms: this.now() - started,
      });
      if (!summary)
        throw new Error(`${this.d.aiName()} returned nothing. Try again.`);
      return summary;
    } finally {
      if (this.running.get(requestId) === controller)
        this.running.delete(requestId);
    }
  }

  cancel(requestId: unknown): boolean {
    if (typeof requestId !== "string") return false;
    const c = this.running.get(requestId);
    c?.abort();
    return Boolean(c);
  }

  /** The provider's own message can quote the request: only its status code goes on. */
  private providerMessage(err: Error): string {
    const name = this.d.aiName();
    const status = /\bHTTP (\d{3})\b/.exec(err.message)?.[1];
    if (err.name === "TimeoutError") return `${name} took too long. Try again.`;
    if (status === "404")
      return `${name} doesn't offer this AI model (HTTP 404). Choose another model in Settings → AI cleanup.`;
    if (status === "401" || status === "403")
      return `${name} didn't accept the API key (HTTP ${status}). Check it in Settings → AI cleanup.`;
    if (status === "429")
      return `${name} is rate-limiting this key, or it has no credits left (HTTP 429). Try again later.`;
    return `${name} couldn't do this${status ? ` (HTTP ${status})` : ""}. Try again.`;
  }
}
