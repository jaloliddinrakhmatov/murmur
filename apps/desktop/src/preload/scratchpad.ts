// The note window's bridge (Stage 9B): notes, Copy, Export, AI edits and the window itself.
// No file system or clipboard access in the page; the main process validates every call.
import { contextBridge, ipcRenderer } from "electron";

const on = <T>(channel: string, cb: (payload: T) => void) => {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("scratchpad", {
  list: (search?: string) => ipcRenderer.invoke("note:list", { search }),
  get: (id: string) => ipcRenderer.invoke("note:get", { id }),
  open: (id: string) => ipcRenderer.invoke("note:open", { id }),
  initial: () => ipcRenderer.invoke("note:initial"),
  create: (body: string) => ipcRenderer.invoke("note:create", { body }),
  save: (id: string, body: string, revision: number) =>
    ipcRenderer.invoke("note:save", { id, body, revision }),
  rename: (id: string, title: string) =>
    ipcRenderer.invoke("note:rename", { id, title }),
  remove: (id: string) =>
    ipcRenderer.invoke("note:delete", { id, confirm: true }),
  copy: (text: string) => ipcRenderer.invoke("note:copy", { text }),
  exportNote: (id: string) => ipcRenderer.invoke("note:export", { id }),
  aiStatus: () => ipcRenderer.invoke("note:aiStatus"),
  ai: (request: unknown) => ipcRenderer.invoke("note:ai", request),
  transforms: () => ipcRenderer.invoke("note:transforms"),
  onTransform: (cb: (transformId: string) => void) => on("note:transform", cb),
  cancelAi: (requestId: string) =>
    ipcRenderer.invoke("note:cancelAi", { requestId }),
  prefs: () => ipcRenderer.invoke("note:prefs"),
  updatePrefs: (patch: unknown) =>
    ipcRenderer.invoke("note:updatePrefs", patch),
  allowAi: (provider: string) =>
    ipcRenderer.invoke("note:allowAi", { provider }),
  openAiSettings: () => ipcRenderer.invoke("note:openAiSettings"),
  hide: () => ipcRenderer.invoke("note:hide"),
  toggleExpand: () => ipcRenderer.invoke("note:toggleExpand"),
  onOpen: (cb: (open: unknown) => void) => on("note:open", cb),
  onInsert: (
    cb: (req: { requestId: string; text: string; expiresAt: number }) => void,
  ) => on("note:insert", cb),
  inserted: (requestId: string, ok: boolean) =>
    ipcRenderer.send("note:inserted", { requestId, ok }),
  onFlush: (cb: (requestId?: string) => void) => on("note:flush", cb),
  flushed: (requestId: string) => ipcRenderer.send("note:flushed", requestId),
  onNotesChanged: (cb: () => void) => on("note:notesChanged", cb),
  onPrefsChanged: (cb: (prefs: unknown) => void) => on("note:prefsChanged", cb),
});
