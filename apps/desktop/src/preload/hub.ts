import { contextBridge, ipcRenderer } from "electron";
import { accountBridge } from "./account-bridge.ts";
import { mcpBridge } from "./mcp-bridge.ts";

const on = (channel: string, cb: () => void) => {
  const listener = () => cb();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("hub", {
  ...accountBridge,
  ...mcpBridge,
  getSettings: () => ipcRenderer.invoke("hub:getSettings"),
  updateSettings: (patch: unknown) =>
    ipcRenderer.invoke("hub:updateSettings", patch),
  getStatus: () => ipcRenderer.invoke("hub:getStatus"),
  checkShortcut: (shortcut: string, action?: string) =>
    ipcRenderer.invoke("hub:checkShortcut", shortcut, action ?? null),
  setActionShortcut: (action: string, shortcut: string | null) =>
    ipcRenderer.invoke("hub:setActionShortcut", { action, shortcut }),
  retrySecureStorage: () => ipcRenderer.invoke("hub:retrySecureStorage"),
  insights: () => ipcRenderer.invoke("hub:insights"),
  copyText: (text: string) => ipcRenderer.invoke("hub:copyText", text),
  copyInsights: () => ipcRenderer.invoke("hub:copyInsights"),
  voiceProfile: () => ipcRenderer.invoke("hub:voiceProfile"),
  generateVoiceProfile: () => ipcRenderer.invoke("hub:generateVoiceProfile"),
  startNewRecordingKey: () => ipcRenderer.invoke("hub:startNewRecordingKey"),
  suspendShortcuts: (suspended: boolean) =>
    ipcRenderer.invoke("hub:suspendShortcuts", suspended),
  microphones: () => ipcRenderer.invoke("hub:microphones"),
  selectMicrophone: (deviceId: string | null) =>
    ipcRenderer.invoke("hub:selectMicrophone", { deviceId }),
  onMicrophonesChanged: (cb: () => void) => on("hub:microphonesChanged", cb),
  startMicPreview: () => ipcRenderer.invoke("hub:startMicPreview"),
  stopMicPreview: (session: number) =>
    ipcRenderer.invoke("hub:stopMicPreview", { session }),
  onMicPreview: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on("hub:micPreview", listener);
    return () => ipcRenderer.removeListener("hub:micPreview", listener);
  },
  setSecret: (provider: string, apiKey: string) =>
    ipcRenderer.invoke("hub:setSecret", provider, apiKey),
  hasSecret: (provider: string) =>
    ipcRenderer.invoke("hub:hasSecret", provider),
  requestMicrophone: () => ipcRenderer.invoke("hub:requestMicrophone"),
  requestAccessibility: () => ipcRenderer.invoke("hub:requestAccessibility"),
  openSystemSettings: (pane: string) =>
    ipcRenderer.invoke("hub:openSystemSettings", pane),
  about: () => ipcRenderer.invoke("hub:about"),
  revealDataFolder: () => ipcRenderer.invoke("hub:revealDataFolder"),
  listHistory: (query?: unknown) =>
    ipcRenderer.invoke("hub:listHistory", query ?? {}),
  historyStats: () => ipcRenderer.invoke("hub:historyStats"),
  queryHistory: (query: unknown) =>
    ipcRenderer.invoke("hub:queryHistory", query ?? {}),
  getDictation: (id: string) => ipcRenderer.invoke("hub:getDictation", id),
  exportData: () => ipcRenderer.invoke("hub:exportData"),
  aiCleanupStatus: () => ipcRenderer.invoke("hub:aiCleanupStatus"),
  listDictionary: (search?: string) =>
    ipcRenderer.invoke("hub:listDictionary", search ?? ""),
  findDictionaryPhrase: (phrase: string) =>
    ipcRenderer.invoke("hub:findDictionaryPhrase", phrase),
  addDictionaryEntry: (entry: unknown) =>
    ipcRenderer.invoke("hub:addDictionaryEntry", entry),
  updateDictionaryEntry: (id: string, patch: unknown) =>
    ipcRenderer.invoke("hub:updateDictionaryEntry", id, patch),
  deleteDictionaryEntry: (id: string) =>
    ipcRenderer.invoke("hub:deleteDictionaryEntry", id),
  importDictionary: () => ipcRenderer.invoke("hub:importDictionary"),
  exportDictionary: () => ipcRenderer.invoke("hub:exportDictionary"),
  listSnippets: (search?: string) =>
    ipcRenderer.invoke("hub:listSnippets", search ?? ""),
  checkSnippet: (candidate: unknown, excludeId?: string | null) =>
    ipcRenderer.invoke("hub:checkSnippet", candidate, excludeId ?? null),
  addSnippet: (snippet: unknown) =>
    ipcRenderer.invoke("hub:addSnippet", snippet),
  updateSnippet: (id: string, patch: unknown) =>
    ipcRenderer.invoke("hub:updateSnippet", id, patch),
  deleteSnippet: (id: string) => ipcRenderer.invoke("hub:deleteSnippet", id),
  previewSnippets: (text: string, draft?: unknown) =>
    ipcRenderer.invoke("hub:previewSnippets", text, draft ?? null),
  onLibraryChanged: (cb: () => void) => on("hub:libraryChanged", cb),
  listNotes: (search?: string) => ipcRenderer.invoke("note:list", { search }),
  showNote: (open: { id: string } | { new: true }) =>
    ipcRenderer.invoke("note:show", open),
  renameNote: (id: string, title: string) =>
    ipcRenderer.invoke("note:rename", { id, title }),
  deleteNote: (id: string) =>
    ipcRenderer.invoke("note:delete", { id, confirm: true }),
  exportNote: (id: string) => ipcRenderer.invoke("note:export", { id }),
  onNotesChanged: (cb: () => void) => on("hub:notesChanged", cb),
  onFlushRequest: (cb: (requestId: string) => void) => {
    const listener = (_e: unknown, requestId: unknown) => {
      if (typeof requestId === "string") cb(requestId);
    };
    ipcRenderer.on("hub:flush", listener);
    return () => ipcRenderer.removeListener("hub:flush", listener);
  },
  flushed: (requestId: string) => ipcRenderer.send("hub:flushed", requestId),
  transforms: (search?: string) => ipcRenderer.invoke("hub:transforms", search),
  createTransform: (input: unknown) =>
    ipcRenderer.invoke("hub:createTransform", input),
  updateTransform: (patch: unknown) =>
    ipcRenderer.invoke("hub:updateTransform", patch),
  deleteTransform: (id: string) =>
    ipcRenderer.invoke("hub:deleteTransform", { id, confirm: true }),
  resetTransforms: () => ipcRenderer.invoke("hub:resetTransforms"),
  setTransformShortcut: (id: string, shortcut: string | null) =>
    ipcRenderer.invoke("hub:setTransformShortcut", { id, shortcut }),
  transformsAiStatus: () => ipcRenderer.invoke("hub:transformsAiStatus"),
  allowTransformsAi: () => ipcRenderer.invoke("hub:allowTransformsAi"),
  allowSummaryAi: (provider: string) =>
    ipcRenderer.invoke("hub:allowSummaryAi", { provider }),
  runTransformExample: (id: string, sample?: string) =>
    ipcRenderer.invoke("hub:runTransformExample", { id, sample }),
  transformDictation: (id: string, transformId: string) =>
    ipcRenderer.invoke("hub:transformDictation", { id, transformId }),
  onTransformsChanged: (cb: () => void) => on("hub:transformsChanged", cb),
  meetings: (query?: unknown) =>
    ipcRenderer.invoke("hub:meetings", query ?? {}),
  meeting: (id: string) => ipcRenderer.invoke("hub:meeting", { id }),
  createMeeting: (input?: unknown) =>
    ipcRenderer.invoke("hub:createMeeting", input ?? {}),
  updateMeeting: (patch: unknown) =>
    ipcRenderer.invoke("hub:updateMeeting", patch),
  saveMeetingNotes: (id: string, notes: string, revision: number) =>
    ipcRenderer.invoke("hub:saveMeetingNotes", { id, notes, revision }),
  deleteMeeting: (id: string) =>
    ipcRenderer.invoke("hub:deleteMeeting", { id, confirm: true }),
  exportMeeting: (id: string) =>
    ipcRenderer.invoke("hub:exportMeeting", { id }),
  importMeetings: () => ipcRenderer.invoke("hub:importMeetings"),
  notetakerReadiness: () => ipcRenderer.invoke("hub:notetakerReadiness"),
  onMeetingsChanged: (cb: () => void) => on("hub:meetingsChanged", cb),
  recordingState: () => ipcRenderer.invoke("hub:recordingState"),
  startNotetaker: () => ipcRenderer.invoke("hub:startNotetaker"),
  calendarStatus: () => ipcRenderer.invoke("hub:calendarStatus"),
  connectCalendar: () => ipcRenderer.invoke("hub:connectCalendar"),
  disconnectCalendar: () => ipcRenderer.invoke("hub:disconnectCalendar"),
  upcomingMeetings: (fresh?: boolean) =>
    ipcRenderer.invoke("hub:upcomingMeetings", { fresh: Boolean(fresh) }),
  startNotetakerFromEvent: (key: string) =>
    ipcRenderer.invoke("hub:startNotetakerFromEvent", { key }),
  startRecording: (id: string) =>
    ipcRenderer.invoke("hub:startRecording", { id }),
  pauseRecording: () => ipcRenderer.invoke("hub:pauseRecording"),
  resumeRecording: () => ipcRenderer.invoke("hub:resumeRecording"),
  stopRecording: () => ipcRenderer.invoke("hub:stopRecording"),
  transcribeMeeting: (id: string) =>
    ipcRenderer.invoke("hub:transcribeMeeting", { id }),
  summarizeMeeting: (id: string, requestId: string) =>
    ipcRenderer.invoke("hub:summarizeMeeting", { id, requestId }),
  cancelSummary: (requestId: string) =>
    ipcRenderer.invoke("hub:cancelSummary", requestId),
  onRecordingChanged: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on("hub:recordingChanged", listener);
    return () => ipcRenderer.removeListener("hub:recordingChanged", listener);
  },
  onTranscriptionProgress: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("hub:transcriptionProgress", listener);
    return () =>
      ipcRenderer.removeListener("hub:transcriptionProgress", listener);
  },
  retryDictation: (id: string) => ipcRenderer.invoke("hub:retryDictation", id),
  dictationAudio: (id: string) => ipcRenderer.invoke("hub:dictationAudio", id),
  dictationRecording: () => ipcRenderer.invoke("hub:dictationRecording"),
  onDictationRecording: (cb: (open: boolean) => void) => {
    const listener = (_e: unknown, open: unknown) => cb(open === true);
    ipcRenderer.on("hub:dictationRecording", listener);
    return () => ipcRenderer.removeListener("hub:dictationRecording", listener);
  },
  copyDictation: (id: string, which: string) =>
    ipcRenderer.invoke("hub:copyDictation", id, which),
  deleteDictation: (id: string) =>
    ipcRenderer.invoke("hub:deleteDictation", id),
  clearHistory: () => ipcRenderer.invoke("hub:clearHistory"),
  setPracticeFocus: (active: boolean, fieldId: string) =>
    ipcRenderer.invoke("hub:setPracticeFocus", { active, fieldId }),
  onPracticeText: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("hub:practiceText", listener);
    return () => ipcRenderer.removeListener("hub:practiceText", listener);
  },
  watchShortcut: (on: boolean) =>
    ipcRenderer.invoke("hub:watchShortcut", { on }),
  onShortcutState: (cb: (e: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("hub:shortcutState", listener);
    return () => ipcRenderer.removeListener("hub:shortcutState", listener);
  },
  systemAudioStatus: () => ipcRenderer.invoke("hub:systemAudioStatus"),
  requestSystemAudio: () => ipcRenderer.invoke("hub:requestSystemAudio"),
  loginItem: () => ipcRenderer.invoke("hub:loginItem"),
  setLoginItem: (enabled: boolean) =>
    ipcRenderer.invoke("hub:setLoginItem", { enabled }),
  resetApp: (options: {
    library: boolean;
    notes: boolean;
    meetings: boolean;
  }) => ipcRenderer.invoke("hub:resetApp", options),
  onHistoryChanged: (cb: () => void) => on("hub:historyChanged", cb),
  onStatusChanged: (cb: () => void) => on("hub:statusChanged", cb),
  onNavigate: (cb: (route: string) => void) => {
    const listener = (_e: unknown, route: string) => cb(route);
    ipcRenderer.on("hub:navigate", listener);
    return () => ipcRenderer.removeListener("hub:navigate", listener);
  },
});
