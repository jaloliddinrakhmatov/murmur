import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("audioBridge", {
  onCommand: (cb: (command: unknown) => void) => {
    ipcRenderer.on("audio:command", (_e, command) => cb(command));
  },
  send: (message: object) => ipcRenderer.send("audio:message", message),
});
