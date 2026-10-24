// The Hub's Notetaker channels. Only the Hub page may call them; NotetakerService validates every
// input. Recording starts only through hub:startRecording / hub:startNotetaker, which the page
// sends when the person presses Start (Stage 9D-2).
import { ipcMain } from "electron";
import type { NotetakerService } from "../notetaker/service.ts";
import { fromHub } from "./hub.ts";

export function registerNotetakerIpc(notetaker: NotetakerService): void {
  const handle = (channel: string, fn: (input: unknown) => unknown) =>
    ipcMain.handle(channel, (e, input: unknown) => {
      if (!fromHub(e)) throw new Error("not allowed");
      return fn(input);
    });
  handle("hub:meetings", (input) => notetaker.list(input));
  handle("hub:meeting", (input) => notetaker.get(input));
  handle("hub:createMeeting", (input) => notetaker.create(input));
  handle("hub:updateMeeting", (input) => notetaker.update(input));
  handle("hub:saveMeetingNotes", (input) => notetaker.saveNotes(input));
  handle("hub:deleteMeeting", (input) => notetaker.delete(input));
  handle("hub:exportMeeting", (input) => notetaker.export(input));
  handle("hub:importMeetings", () => notetaker.import());
  handle("hub:notetakerReadiness", () => notetaker.readiness());
  handle("hub:recordingState", () => notetaker.recordingState());
  handle("hub:startNotetaker", () => notetaker.startNotetaker());
  handle("hub:startRecording", (input) => notetaker.startRecording(input));
  handle("hub:pauseRecording", () => notetaker.pauseRecording());
  handle("hub:resumeRecording", () => notetaker.resumeRecording());
  handle("hub:stopRecording", () => notetaker.stopRecording());
  // Transcription runs in the background; the page follows hub:meetingsChanged.
  handle("hub:transcribeMeeting", (input) => {
    void notetaker.transcribe(input).catch(() => {});
  });
  handle("hub:summarizeMeeting", (input) => notetaker.summarize(input));
  handle("hub:cancelSummary", (input) => notetaker.cancelSummary(input));
}
