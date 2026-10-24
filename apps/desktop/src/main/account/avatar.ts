// Profile pictures: whatever the person picks is cropped to a square and shrunk here, in the
// main process, to a PNG or JPEG data URL under the server's limit. The window never sees the file.
import { RULES } from "@murmur/account-api";
import { AccountError } from "./errors.ts";

/** The few image operations needed (Electron's nativeImage in the app, a fake in tests). */
export interface AvatarImage {
  isEmpty(): boolean;
  /** Crops to the largest centred square. */
  square(): AvatarImage;
  /** Scales to side × side. */
  scaled(side: number): AvatarImage;
  size(): number;
  png(): Buffer;
  jpeg(quality: number): Buffer;
}

const SIDES = [512, 384, 256, 160, 96];
const QUALITIES = [85, 70, 50];

/** A data URL for the picture, at most `maxBytes` decoded; PNG first, then JPEG at lower quality. */
export function fitAvatar(
  image: AvatarImage,
  maxBytes: number = RULES.avatarMaxBytes,
): string {
  if (image.isEmpty())
    throw new AccountError(
      "invalid-input",
      "That file isn't a picture Murmur can read. Choose a PNG or JPEG.",
    );
  const square = image.square();
  for (const side of SIDES) {
    const scaled = square.size() > side ? square.scaled(side) : square;
    const png = scaled.png();
    if (png.length <= maxBytes)
      return `data:image/png;base64,${png.toString("base64")}`;
    for (const q of QUALITIES) {
      const jpeg = scaled.jpeg(q);
      if (jpeg.length <= maxBytes)
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    }
  }
  throw new AccountError(
    "invalid-input",
    "That picture is too large to use. Choose a smaller one.",
  );
}
