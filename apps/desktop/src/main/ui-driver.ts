// Drives a Hub window like a user would, for the smoke test and screenshot capture: real key
// events and typed text, clicks that focus first (as a mouse click on a button does in
// Chromium), and polling for the resulting state.
import type { BrowserWindow } from "electron";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ActiveElement {
  /** Associated <label> text, else aria-label. */
  label: string;
  text: string;
  tag: string;
  value: string | null;
}

export function uiDriver(win: BrowserWindow) {
  const wc = win.webContents;
  const js = <T>(code: string): Promise<T> => wc.executeJavaScript(code);
  const press = (selectorExpr: string) =>
    js(`(() => { const b = ${selectorExpr}; b.focus(); b.click(); })()`);
  return {
    js,
    sleep,
    async waitFor(code: string, ms = 2500): Promise<boolean> {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(50))
        if (await js<boolean>(`Boolean(${code})`).catch(() => false))
          return true;
      return false;
    },
    async key(keyCode: string, modifiers: ("meta" | "shift")[] = []) {
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (keyCode === "Return")
        wc.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await sleep(250);
    },
    async type(text: string) {
      await wc.insertText(text);
      await sleep(350);
    },
    click: (selector: string) =>
      press(`document.querySelector(${JSON.stringify(selector)})`),
    clickText: (text: string, scope = "document") =>
      press(
        `[...${scope}.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)})`,
      ),
    active: () =>
      js<ActiveElement>(
        `(() => { const a = document.activeElement; const l = a?.id ? document.querySelector('label[for="' + a.id + '"]')?.textContent : null; return { label: l ?? a?.getAttribute("aria-label") ?? "", text: a?.textContent?.trim() ?? "", tag: a?.tagName ?? "", value: "value" in a ? a.value : null }; })()`,
      ),
    /**
     * The window may not be the key window (the developer keeps working in another app); let the
     * page behave as focused so focus, :focus-visible and key events work as for a user.
     */
    async emulateFocus(enabled: boolean) {
      if (enabled && !wc.debugger.isAttached()) wc.debugger.attach("1.3");
      if (!wc.debugger.isAttached()) return;
      await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled,
      });
      if (!enabled) wc.debugger.detach();
    },
  };
}
