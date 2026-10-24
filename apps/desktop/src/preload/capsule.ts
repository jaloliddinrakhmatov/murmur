import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("capsuleBridge", {
  onState: (
    cb: (payload: { state: string; message?: string; seq: number }) => void,
  ) => {
    ipcRenderer.on("capsule:state", (_e, payload) => cb(payload));
  },
  onNotice: (cb: (notice: string | null) => void) => {
    ipcRenderer.on("capsule:notice", (_e, notice) => cb(notice));
  },
  onMeeting: (
    cb: (meeting: { text: string; paused: boolean } | null) => void,
  ) => {
    ipcRenderer.on("capsule:meeting", (_e, meeting) => cb(meeting));
  },
  onLevel: (cb: (rms: number) => void) => {
    ipcRenderer.on("capsule:level", (_e, rms) => cb(rms));
  },
  onSound: (cb: (kind: string) => void) => {
    ipcRenderer.on("capsule:sound", (_e, kind) => cb(kind));
  },
  onProbe: (cb: (seq: number) => void) => {
    ipcRenderer.on("capsule:probe", (_e, seq) => cb(seq));
  },
  painted: (
    seq: number,
    receivedAt: number,
    workDoneAt: number,
    paintedAt: number,
  ) =>
    ipcRenderer.send("capsule:painted", seq, receivedAt, workDoneAt, paintedAt),
  setInteractive: (on: boolean) =>
    ipcRenderer.send("capsule:interactive", Boolean(on)),
  clicked: () => ipcRenderer.send("capsule:clicked"),
  cancel: () => ipcRenderer.send("capsule:cancel"),
});
