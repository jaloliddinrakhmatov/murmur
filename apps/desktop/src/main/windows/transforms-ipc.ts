// The Hub's Transforms channels (Stage 9C). Only the Hub page may call them; every input is
// validated by TransformService or here. Running an example or a History entry is an explicit
// request from the page, never automatic.
import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import { z } from "zod";
import {
  TRANSFORM_EXAMPLES,
  TransformIdSchema,
} from "../../shared/transforms.ts";
import type { HistoryDb } from "../history/db.ts";
import type { TransformService } from "../transforms/service.ts";
import type { TransformSessions } from "../transforms/session.ts";
import { fromHub } from "./hub.ts";

const ExampleSchema = TransformIdSchema.extend({
  sample: z.string().max(2000).optional(),
});

const DictationTransformSchema = z.object({
  id: z.string().min(1).max(64),
  transformId: z.string().min(1).max(64),
});

/** The service the page named when it asked: consent is never granted to a different one. */
const AllowSummaryAiSchema = z.object({ provider: z.string().min(1).max(40) });

export function registerTransformIpc(
  transforms: TransformService,
  sessions: TransformSessions,
  allowAi: () => void,
  allowSummaryAi: (provider: string) => void,
  history: HistoryDb,
): void {
  const handle = (channel: string, fn: (input: unknown) => unknown) =>
    ipcMain.handle(channel, (e, input: unknown) => {
      if (!fromHub(e)) throw new Error("not allowed");
      return fn(input);
    });
  handle("hub:transforms", (search) =>
    transforms.list(typeof search === "string" ? search : ""),
  );
  handle("hub:createTransform", (input) => transforms.create(input));
  handle("hub:updateTransform", (input) => transforms.update(input));
  handle("hub:deleteTransform", (input) => transforms.delete(input));
  handle("hub:resetTransforms", () => transforms.resetDefaults());
  handle("hub:setTransformShortcut", (input) => transforms.setShortcut(input));
  handle("hub:transformsAiStatus", () => transforms.aiStatus());
  handle("hub:allowTransformsAi", () => allowAi());
  handle("hub:allowSummaryAi", (input) =>
    allowSummaryAi(AllowSummaryAiSchema.parse(input).provider),
  );
  // "See Updates": the built-in example text (never the person's own), on request.
  handle("hub:runTransformExample", async (input) => {
    const { id, sample } = ExampleSchema.parse(input);
    const t = transforms.get({ id });
    if (!t) throw new Error("This transform no longer exists.");
    // Your own Transforms take a sample you typed in the editor for this; the built-ins use theirs.
    const example =
      t.kind === "custom"
        ? sample?.trim() || TRANSFORM_EXAMPLES.polish.example
        : TRANSFORM_EXAMPLES[t.kind].example;
    const out = await transforms.run({
      requestId: randomUUID(),
      transformId: id,
      text: example,
    });
    return { before: example, after: out.text };
  });
  // History "Transform…": the dictation's refined text, in the Transform panel (copy only).
  handle("hub:transformDictation", async (input) => {
    const { id, transformId } = DictationTransformSchema.parse(input);
    const row = history.get(id);
    const text = row?.finalText?.trim();
    if (!text) throw new Error("This dictation has no text to transform.");
    await sessions.startWithText(transformId, text);
  });
}
