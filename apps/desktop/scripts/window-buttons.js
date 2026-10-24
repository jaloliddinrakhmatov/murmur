// Prints the screen frames (points, top-left origin) of each of a process's windows and their
// traffic-light buttons as a JSON array, read through the Accessibility API from JXA. Used by capture
// mode to check that title-bar controls clear the native buttons, which webContents.capturePage
// cannot render. Needs Accessibility permission for the calling terminal; no Automation prompt.
// Usage: osascript -l JavaScript scripts/window-buttons.js <pid>
ObjC.import("ApplicationServices");

function attr(element, name) {
  const ref = Ref();
  return $.AXUIElementCopyAttributeValue(element, $(name), ref) === 0
    ? ObjC.castRefToObject(ref[0])
    : null;
}

// AXValue has no JXA struct accessor; its description is stable: "{value = x:18 y:18 ...}".
function frame(element) {
  const position = attr(element, "AXPosition");
  const size = attr(element, "AXSize");
  if (!position || !size) return null;
  const read = (value, key) =>
    Number(new RegExp(key + ":(-?[\\d.]+)").exec(value.description.js)[1]);
  return {
    x: read(position, "x"),
    y: read(position, "y"),
    width: read(size, "w"),
    height: read(size, "h"),
  };
}

function run(argv) {
  if (!$.AXIsProcessTrusted())
    throw new Error("Accessibility permission is not granted");
  const app = $.AXUIElementCreateApplication(Number(argv[0]));
  const windows = attr(app, "AXWindows");
  if (!windows) {
    const ref = Ref();
    const code = $.AXUIElementCopyAttributeValue(app, $("AXRole"), ref);
    throw new Error(
      "no windows for pid " + argv[0] + " (AX error " + code + ")",
    );
  }
  const result = [];
  for (let i = 0; i < windows.count; i++) {
    const win = windows.objectAtIndex(i);
    const entry = { window: frame(win) };
    for (const [key, name] of [
      ["close", "AXCloseButton"],
      ["minimize", "AXMinimizeButton"],
      ["zoom", "AXZoomButton"],
    ]) {
      const button = attr(win, name);
      if (button) entry[key] = frame(button);
    }
    result.push(entry);
  }
  return JSON.stringify(result);
}
