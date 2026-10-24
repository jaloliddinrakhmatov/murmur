import { app, Menu, nativeImage, Tray } from "electron";

export interface TrayActions {
  openHub: () => void;
  openSettings: () => void;
  shortcutLabel: () => string;
  lastTranscript: () => { available: boolean; hasOriginal: boolean };
  pasteLast: () => void;
  copyLast: (which: "final" | "raw") => void;
  /** Stage 9D-2: the meeting being recorded, if any. */
  meeting?: () => { paused: boolean; clock: string } | null;
  pauseMeeting?: () => void;
  resumeMeeting?: () => void;
  stopMeeting?: () => void;
  openMeeting?: () => void;
}

export interface MurmurTray {
  tray: Tray;
  /** Rebuilds the menu and the title next to the icon (the recording time). */
  refresh: () => void;
}

export function createTray(iconPath: string, actions: TrayActions): MurmurTray {
  const image = nativeImage.createFromPath(iconPath);
  image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setToolTip("Murmur");
  const rebuild = () => {
    const meeting = actions.meeting?.() ?? null;
    // Always visible while a meeting records, whatever the Capsule setting.
    tray.setTitle(
      meeting ? ` ${meeting.paused ? "Paused" : "●"} ${meeting.clock}` : "",
    );
    tray.setToolTip(
      meeting
        ? meeting.paused
          ? "Murmur: meeting recording paused"
          : "Murmur: recording a meeting"
        : "Murmur",
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...meetingItems(actions, meeting),
        { label: `Hold ${actions.shortcutLabel()} to dictate`, enabled: false },
        { type: "separator" },
        ...lastTranscriptItems(actions),
        { type: "separator" },
        { label: "Open Murmur", click: actions.openHub },
        { label: "Settings…", click: actions.openSettings },
        { type: "separator" },
        { label: "Quit Murmur", click: () => app.quit() },
      ]),
    );
  };
  rebuild();
  tray.on("click", rebuild);
  return { tray, refresh: rebuild };
}

function meetingItems(
  actions: TrayActions,
  meeting: { paused: boolean; clock: string } | null,
): Electron.MenuItemConstructorOptions[] {
  if (!meeting) return [];
  return [
    {
      label: meeting.paused
        ? `Meeting recording paused (${meeting.clock})`
        : `Recording a meeting (${meeting.clock})`,
      enabled: false,
    },
    meeting.paused
      ? { label: "Resume Recording", click: actions.resumeMeeting }
      : { label: "Pause Recording", click: actions.pauseMeeting },
    { label: "Stop Recording", click: actions.stopMeeting },
    { label: "Open Meeting", click: actions.openMeeting },
    { type: "separator" },
  ];
}

/**
 * The last dictation, from the menu bar. Opening this menu doesn't change the app in front, so
 * “Paste” goes where the cursor was (with the same safety rules as a dictation).
 */
function lastTranscriptItems(
  actions: TrayActions,
): Electron.MenuItemConstructorOptions[] {
  const last = actions.lastTranscript();
  return [
    {
      label: "Paste Last Transcript",
      enabled: last.available,
      click: actions.pasteLast,
    },
    {
      label: "Copy Last Transcript",
      enabled: last.available,
      click: () => actions.copyLast("final"),
    },
    ...(last.hasOriginal
      ? [
          {
            label: "Copy Original Words",
            click: () => actions.copyLast("raw"),
          },
        ]
      : []),
  ];
}
