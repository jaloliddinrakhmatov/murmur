const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capsuleBridge", {
  onState: (fn) =>
    ipcRenderer.on("capsule:state", (_e, payload) => fn(payload)),
  painted: (seq) => ipcRenderer.send("capsule:painted", seq),
  setInteractive: (on) => ipcRenderer.send("capsule:interactive", Boolean(on)),
  clicked: () => ipcRenderer.send("capsule:clicked"),
});

contextBridge.exposeInMainWorld("editorBridge", {
  report: (payload) => ipcRenderer.send("editor:report", payload),
  onQuery: (fn) => ipcRenderer.on("editor:query", () => fn()),
});
