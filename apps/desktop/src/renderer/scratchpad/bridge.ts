import type { Note, NoteSummary, SaveResult } from "../../shared/notes.ts";
import type { Settings } from "../../shared/settings.ts";

export type NotePrefs = Settings["scratchpad"];
export type NoteOpen = { id: string } | { new: true } | { resume: true };

export interface ScratchpadApi {
  list(search?: string): Promise<NoteSummary[]>;
  get(id: string): Promise<Note | null>;
  open(id: string): Promise<Note | null>;
  initial(): Promise<Note | null>;
  create(body: string): Promise<Note>;
  save(id: string, body: string, revision: number): Promise<SaveResult>;
  rename(id: string, title: string): Promise<Note>;
  remove(id: string): Promise<boolean>;
  copy(text: string): Promise<boolean>;
  exportNote(id: string): Promise<{ saved: boolean; path?: string }>;
  aiStatus(): Promise<{
    ready: string | null;
    service: string;
    provider: string;
    consented: boolean;
  }>;
  ai(request: {
    requestId: string;
    transformId?: string;
    instruction?: string;
    text: string;
  }): Promise<{ text: string; name: string }>;
  cancelAi(requestId: string): Promise<boolean>;
  /** Stage 9C: My Transforms, for the AI menu. */
  transforms(): Promise<{ id: string; name: string; description: string }[]>;
  /** A transform shortcut pressed while this window is in front. */
  onTransform(cb: (transformId: string) => void): () => void;
  prefs(): Promise<NotePrefs>;
  updatePrefs(patch: Partial<NotePrefs>): Promise<NotePrefs>;
  /** Agree to send note text to this AI service (the consent dialog's button). */
  allowAi(provider: string): Promise<NotePrefs>;
  openAiSettings(): Promise<void>;
  hide(): Promise<void>;
  toggleExpand(): Promise<boolean>;
  onOpen(cb: (open: NoteOpen) => void): () => void;
  onInsert(
    cb: (req: { requestId: string; text: string; expiresAt: number }) => void,
  ): () => void;
  inserted(requestId: string, ok: boolean): void;
  onFlush(cb: (requestId?: string) => void): () => void;
  flushed(requestId: string): void;
  onNotesChanged(cb: () => void): () => void;
  onPrefsChanged(cb: (prefs: NotePrefs) => void): () => void;
}

declare global {
  interface Window {
    scratchpad: ScratchpadApi;
  }
}

export const api = window.scratchpad;
