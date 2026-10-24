import { z } from "zod";
import { SettingsSchema } from "./settings.ts";

const shape = SettingsSchema.shape.scratchpad.unwrap().shape;

/**
 * What the note window may change about itself. Anything else (AI consent above all) is
 * refused, not ignored: consent changes only through `note:allowAi`.
 */
export const NotePrefsPatchSchema = z.strictObject({
  openBehavior: shape.openBehavior.unwrap().optional(),
  font: shape.font.unwrap().optional(),
  size: shape.size.unwrap().optional(),
});
