// The Transform panel's bridge (Stage 9C): it renders the state the main process sends and
// reports which button was pressed. No other access.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("transformPanel", {
  state: () => ipcRenderer.invoke("transform:state"),
  onState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => cb(state);
    ipcRenderer.on("transform:state", listener);
    return () => ipcRenderer.removeListener("transform:state", listener);
  },
  act: (action: string) => ipcRenderer.send("transform:action", action),
});
