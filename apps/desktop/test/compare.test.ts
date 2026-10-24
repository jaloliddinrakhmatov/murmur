import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blank,
  colorAt,
  crop,
  difference,
  firstChange,
  flatten,
  opaqueBounds,
  overlay,
  regionStats,
  resize,
  RGB,
  sideBySide,
  swapRedBlue,
  type Bitmap,
} from "../src/main/compare/bitmap.ts";

const px = (img: Bitmap, x: number, y: number) =>
  Array.from(
    img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4),
  );

import { evaluate, toHex, type Measured } from "../src/main/compare/spec.ts";
test("a window is found inside its transparent drop shadow and cropped exactly", () => {
  const img = blank(10, 8, [0, 0, 0]);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 40; // shadow
  for (let y = 2; y < 6; y++)
    for (let x = 3; x < 8; x++) img.data[(y * 10 + x) * 4 + 3] = 255;
  const r = opaqueBounds(img)!;
  assert.deepEqual(r, { x: 3, y: 2, width: 5, height: 4 });
  const c = crop(img, r);
  assert.equal(c.width, 5);
  assert.equal(c.data[3], 255);
  assert.equal(
    opaqueBounds({ width: 2, height: 2, data: new Uint8Array(16) }),
    null,
    "fully transparent",
  );
});

test("Electron's BGRA bitmaps round-trip to RGBA", () => {
  const bgra = new Uint8Array([241, 244, 245, 255]); // #f5f4f1 as BGRA
  assert.deepEqual(Array.from(swapRedBlue(bgra)), [245, 244, 241, 255]);
  assert.deepEqual(
    Array.from(swapRedBlue(swapRedBlue(bgra))),
    Array.from(bgra),
  );
});

test("transparent corners are flattened onto the given colour", () => {
  const img = blank(1, 1, RGB("#ffffff"));
  img.data[3] = 0;
  assert.deepEqual(
    px(flatten(img, RGB("#f5f4f1")), 0, 0),
    [245, 244, 241, 255],
  );
});

test("resize keeps flat colours, halves and doubles dimensions", () => {
  const img = blank(4, 2, RGB("#eeebe4"));
  const half = resize(img, 2, 1);
  assert.equal(half.width, 2);
  assert.deepEqual(px(half, 1, 0), [238, 235, 228, 255]);
  assert.equal(resize(img, 4, 2), img, "same size returns the input");
  assert.equal(resize(img, 8, 4).data.length, 8 * 4 * 4);
});

test("side-by-side places reference left and candidate right with a gap", () => {
  const out = sideBySide(blank(3, 2, [255, 0, 0]), blank(2, 3, [0, 0, 255]), 1);
  assert.equal(out.width, 6);
  assert.equal(out.height, 3);
  assert.deepEqual(px(out, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(px(out, 3, 0), [128, 128, 128, 255]);
  assert.deepEqual(px(out, 4, 2), [0, 0, 255, 255]);
});

test("overlay blends at the requested opacity", () => {
  const out = overlay(blank(1, 1, [0, 0, 0]), blank(1, 1, [200, 100, 50]), 0.5);
  assert.deepEqual(px(out, 0, 0), [100, 50, 25, 255]);
  assert.throws(() => overlay(blank(1, 1), blank(2, 1)));
});

test("difference counts pixels beyond the threshold and marks them magenta", () => {
  const a = blank(4, 1, RGB("#fcfcfb"));
  const b = blank(4, 1, RGB("#fcfcfb"));
  b.data.set([252, 252, 240, 255], 0); // within threshold (11)
  b.data.set([26, 26, 26, 255], 4); // text-dark pixel: a real difference
  const { image, stats } = difference(a, b, 24);
  assert.equal(stats.mismatch, 0.25);
  assert.ok(stats.meanDelta > 0);
  const [r, g, bl] = px(image, 1, 0);
  assert.ok(r > 200 && bl > 200 && g < 100, "differing pixel is magenta");
  const [r0, g0] = px(image, 0, 0);
  assert.equal(r0, g0, "matching pixel stays grey");
  assert.equal(
    regionStats(a, b, { x: 2, y: 0, width: 2, height: 1 }).mismatch,
    0,
  );
});

test("edges and colours are probed from the pixels", () => {
  const img = blank(10, 4, RGB("#f5f4f1"));
  for (let y = 0; y < 4; y++)
    for (let x = 6; x < 10; x++)
      img.data.set([252, 252, 251, 255], (y * 10 + x) * 4);
  assert.deepEqual(firstChange(img, 0, 1, 1, 0, 20), { x: 6, y: 1 });
  assert.equal(firstChange(img, 0, 1, 1, 0, 20, 10), null, "within tolerance");
  assert.equal(firstChange(img, 0, 1, 0, 1, 20), null, "runs off the image");
  assert.equal(colorAt(img, 7, 2), "#fcfcfb");
});

test("DOM probes: measurements are checked within tolerance; colours compared as hex", () => {
  const m: Measured = {
    left: 216.4,
    top: 52,
    width: 1126,
    height: 790,
    fontFamily: '"Figtree", -apple-system, sans-serif',
    fontSize: 15,
    fontWeight: 500,
    color: "rgb(26, 26, 26)",
    background: "rgb(252, 252, 251)",
    radius: 24,
    borderColor: "rgb(238, 235, 228)",
  };
  const results = evaluate(
    {
      name: "sheet",
      selector: "main",
      numbers: { left: [216, 1], radius: [20, 2] },
      text: { fontFamily: "Figtree", background: "#fcfcfb", color: "#000000" },
      centerX: [779, 1],
    },
    m,
  );
  const by = (check: string) => results.find((r) => r.check === check)!;
  assert.equal(by("left").pass, true);
  assert.equal(by("radius").pass, false, "24 is outside 20 ±2");
  assert.equal(by("fontFamily").pass, true, "first family, quotes stripped");
  assert.equal(by("background").pass, true);
  assert.equal(by("color").pass, false);
  assert.equal(by("centerX").pass, true);
  assert.deepEqual(
    evaluate({ name: "x", selector: ".none" }, null)[0].pass,
    false,
  );
  assert.equal(toHex("rgba(0, 0, 0, 0)"), "transparent");
  assert.equal(toHex("rgb(245 244 241 / 1)"), "#f5f4f1");
});
