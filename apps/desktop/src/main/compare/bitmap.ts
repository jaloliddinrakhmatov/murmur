// Pure RGBA image operations for the reference comparison tool (`npm run compare`). No Electron
// imports, so they are unit-tested under Node (test/compare.test.ts).

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, row-major. */
  data: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const RGB = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export function blank(
  width: number,
  height: number,
  [r, g, b]: [number, number, number] = [255, 255, 255],
): Bitmap {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Electron's `toBitmap()` / `createFromBitmap()` use BGRA; this swaps to and from RGBA. */
export function swapRedBlue(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = src[i + 2];
    out[i + 2] = src[i];
  }
  return out;
}

/**
 * Bounds of the pixels with alpha ≥ `minAlpha`: a window without its drop shadow. macOS
 * shadows reach alpha 250 right under the window edge, hence the default of 251.
 */
export function opaqueBounds(img: Bitmap, minAlpha = 251): Rect | null {
  let x0 = img.width,
    y0 = img.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] >= minAlpha) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0
    ? null
    : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function crop(img: Bitmap, r: Rect): Bitmap {
  const out = new Uint8Array(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    const start = ((r.y + y) * img.width + r.x) * 4;
    out.set(img.data.subarray(start, start + r.width * 4), y * r.width * 4);
  }
  return { width: r.width, height: r.height, data: out };
}

/** Composites onto an opaque background (transparent window corners become `bg`). */
export function flatten(img: Bitmap, bg: [number, number, number]): Bitmap {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = img.data[i + 3] / 255;
    for (let c = 0; c < 3; c++)
      out[i + c] = Math.round(img.data[i + c] * a + bg[c] * (1 - a));
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/** Bilinear resize; returns the same image when the size already matches. */
export function resize(img: Bitmap, width: number, height: number): Bitmap {
  if (img.width === width && img.height === height) return img;
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width,
    sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(img.height - 1, Math.floor(fy)),
      y1 = Math.min(img.height - 1, y0 + 1),
      wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(img.width - 1, Math.floor(fx)),
        x1 = Math.min(img.width - 1, x0 + 1),
        wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number) =>
          img.data[(yy * img.width + xx) * 4 + c];
        const top = p(y0, x0) * (1 - wx) + p(y0, x1) * wx;
        const bottom = p(y1, x0) * (1 - wx) + p(y1, x1) * wx;
        out[(y * width + x) * 4 + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { width, height, data: out };
}

/** Left and right images next to each other with a gap. Heights may differ. */
export function sideBySide(
  left: Bitmap,
  right: Bitmap,
  gap = 24,
  bg: [number, number, number] = [128, 128, 128],
): Bitmap {
  const out = blank(
    left.width + gap + right.width,
    Math.max(left.height, right.height),
    bg,
  );
  paste(out, left, 0, 0);
  paste(out, right, left.width + gap, 0);
  return out;
}

export function paste(dst: Bitmap, src: Bitmap, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++)
    dst.data.set(
      src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4),
      ((dy + y) * dst.width + dx) * 4,
    );
}

/** `top` drawn over `bottom` at the given opacity (onion skin). Same size required. */
export function overlay(bottom: Bitmap, top: Bitmap, opacity = 0.5): Bitmap {
  assertSameSize(bottom, top);
  const out = new Uint8Array(bottom.data.length);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++)
      out[i + c] = Math.round(
        bottom.data[i + c] * (1 - opacity) + top.data[i + c] * opacity,
      );
    out[i + 3] = 255;
  }
  return { width: bottom.width, height: bottom.height, data: out };
}

export interface DiffStats {
  /** Share of pixels whose largest channel difference exceeds the threshold (0–1). */
  mismatch: number;
  /** Mean absolute channel difference over all pixels (0–255). */
  meanDelta: number;
  pixels: number;
}

/**
 * Per-pixel difference. The image shows the reference faded to grey, with every differing pixel
 * in magenta (brighter = larger difference), so both layout and colour shifts stand out.
 */
export function difference(
  reference: Bitmap,
  candidate: Bitmap,
  threshold = 24,
): { image: Bitmap; stats: DiffStats } {
  assertSameSize(reference, candidate);
  const out = new Uint8Array(reference.data.length);
  let mismatched = 0,
    total = 0;
  for (let i = 0; i < out.length; i += 4) {
    let max = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(reference.data[i + c] - candidate.data[i + c]);
      total += d;
      if (d > max) max = d;
    }
    const grey =
      (reference.data[i] + reference.data[i + 1] + reference.data[i + 2]) / 3;
    const faded = Math.round(200 + grey * 0.2);
    if (max > threshold) {
      mismatched++;
      const k = Math.min(1, 0.35 + max / 255);
      out[i] = Math.round(255 * k + faded * (1 - k));
      out[i + 1] = Math.round(faded * (1 - k));
      out[i + 2] = Math.round(255 * k + faded * (1 - k));
    } else out[i] = out[i + 1] = out[i + 2] = faded;
    out[i + 3] = 255;
  }
  const pixels = reference.width * reference.height;
  return {
    image: { width: reference.width, height: reference.height, data: out },
    stats: {
      mismatch: mismatched / pixels,
      meanDelta: total / pixels / 3,
      pixels,
    },
  };
}

/** Difference statistics for one region (rect in the images' pixel space). */
export function regionStats(
  reference: Bitmap,
  candidate: Bitmap,
  r: Rect,
  threshold = 24,
): DiffStats {
  return difference(crop(reference, r), crop(candidate, r), threshold).stats;
}

function assertSameSize(a: Bitmap, b: Bitmap): void {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(
      `size mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height}`,
    );
}

export const colorAt = (img: Bitmap, x: number, y: number): string => {
  const i = (Math.round(y) * img.width + Math.round(x)) * 4;
  return `#${[0, 1, 2].map((c) => img.data[i + c].toString(16).padStart(2, "0")).join("")}`;
};

/**
 * Walks from (x, y) in steps of (dx, dy) and returns the first position whose colour differs
 * from the starting colour by more than `tolerance` on any channel, or null. Used to find
 * edges (e.g. where the canvas ends and the content sheet begins).
 */
export function firstChange(
  img: Bitmap,
  x: number,
  y: number,
  dx: number,
  dy: number,
  maxSteps: number,
  tolerance = 3,
): { x: number; y: number } | null {
  const at = (px: number, py: number) => (py * img.width + px) * 4;
  const start = at(x, y);
  for (let s = 1; s <= maxSteps; s++) {
    const px = x + dx * s,
      py = y + dy * s;
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
    const i = at(px, py);
    for (let c = 0; c < 3; c++)
      if (Math.abs(img.data[i + c] - img.data[start + c]) > tolerance)
        return { x: px, y: py };
  }
  return null;
}
