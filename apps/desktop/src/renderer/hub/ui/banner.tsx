// Page banners (reference: dark, defocused photographs with a serif heading). Murmur's artwork
// is original and drawn in CSS: soft radial light patches over a dark warm base plus a fine
// grain, tuned per page to the reference banner's size and brightness profile
//. No image files, no third-party rights.
import type { CSSProperties, ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "./cn.ts";

interface Scene {
  base: string;
  /** Radial light patches: [x %, y %, size %, colour]. */
  patches: [number, number, number, string][];
}

/** Measured reference brightness (left/middle/right thirds, 0–255) in comments. */
const SCENES = {
  // Dictation: 36 / 56 / 83, dark on the left, lighter cool-blue haze on the right.
  dictation: {
    base: "#121212",
    patches: [
      [55, 40, 40, "rgba(70, 62, 52, 0.7)"],
      [78, 45, 35, "rgba(96, 120, 132, 0.75)"],
      [92, 70, 30, "rgba(132, 120, 108, 0.6)"],
      [88, 15, 25, "rgba(150, 170, 182, 0.55)"],
    ],
  },
  // Dictionary: 90 / 68 / 102, warm brown with light at both ends.
  dictionary: {
    base: "#3e2c22",
    patches: [
      [8, 30, 45, "rgba(150, 118, 92, 0.75)"],
      [45, 70, 45, "rgba(92, 70, 56, 0.6)"],
      [88, 35, 45, "rgba(170, 140, 108, 0.75)"],
      [70, 10, 30, "rgba(110, 100, 96, 0.5)"],
    ],
  },
  // Snippets: 86 / 99 / 66, mixed warm and cool, brightest in the middle.
  snippets: {
    base: "#2f2b28",
    patches: [
      [15, 40, 45, "rgba(120, 128, 140, 0.65)"],
      [52, 30, 50, "rgba(168, 150, 128, 0.7)"],
      [80, 70, 40, "rgba(86, 76, 66, 0.6)"],
      [95, 20, 30, "rgba(70, 64, 60, 0.5)"],
    ],
  },
  // Style: 72 / 83 / 55, cool olive grey.
  style: {
    base: "#34332d",
    patches: [
      [12, 20, 55, "rgba(132, 126, 112, 0.75)"],
      [48, 30, 60, "rgba(150, 146, 132, 0.7)"],
      [70, 85, 45, "rgba(98, 84, 66, 0.6)"],
      [92, 40, 40, "rgba(64, 74, 58, 0.7)"],
    ],
  },
  // Transforms: cool blue haze on the left, warm brown on the right.
  transforms: {
    base: "#1f2226",
    patches: [
      [15, 25, 45, "rgba(96, 126, 150, 0.7)"],
      [45, 60, 45, "rgba(120, 110, 96, 0.55)"],
      [80, 35, 45, "rgba(150, 120, 92, 0.6)"],
      [95, 85, 30, "rgba(70, 60, 52, 0.6)"],
    ],
  },
  // Scratchpad: warm amber paper light, dark at the edges.
  scratchpad: {
    base: "#2b1d15",
    patches: [
      [20, 30, 45, "rgba(150, 112, 70, 0.7)"],
      [50, 20, 45, "rgba(184, 150, 104, 0.65)"],
      [78, 55, 40, "rgba(120, 84, 58, 0.7)"],
      [95, 85, 30, "rgba(70, 44, 36, 0.6)"],
    ],
  },
} satisfies Record<string, Scene>;

export type BannerScene = keyof typeof SCENES;

// Fine film grain, so the patches read as an out-of-focus scene rather than a flat gradient.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.35'/%3E%3C/svg%3E\")";

function sceneStyle(scene: Scene): CSSProperties {
  const patches = scene.patches.map(
    ([x, y, size, color]) =>
      `radial-gradient(${size}% ${size * 1.6}% at ${x}% ${y}%, ${color}, transparent 70%)`,
  );
  return {
    backgroundColor: scene.base,
    backgroundImage: [
      // Darker on the left, behind the text.
      "linear-gradient(90deg, rgba(0,0,0,0.35), rgba(0,0,0,0) 60%)",
      GRAIN,
      ...patches,
    ].join(", "),
    backgroundBlendMode: [
      "normal",
      "overlay",
      ...patches.map(() => "normal"),
    ].join(", "),
  };
}

export function Banner({
  scene,
  title,
  children,
  actions,
  onDismiss,
  aside,
  tight = false,
  className,
}: {
  scene: BannerScene;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Shows the × button; the caller persists the dismissal. */
  onDismiss?: () => void;
  /** Decorative artwork in the bottom-right corner (hidden from assistive technology). */
  aside?: ReactNode;
  /** 28 pt instead of 32 pt top and bottom (the Transforms banner is 199 pt tall). */
  tight?: boolean;
  className?: string;
}) {
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      data-banner={scene}
      className={cn(
        "relative overflow-hidden rounded-list px-8 text-on-image",
        tight ? "py-7" : "py-8",
        className,
      )}
      style={sceneStyle(SCENES[scene])}
    >
      <h2 className="font-serif text-banner tracking-[-0.015em]">{title}</h2>
      {children && (
        <div className="mt-2 max-w-[620px] space-y-2 text-body text-on-image/95">
          {children}
        </div>
      )}
      {actions && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
      {aside && (
        <div
          aria-hidden
          className="pointer-events-none absolute bottom-0 right-[44px] max-[900px]:hidden"
        >
          {aside}
        </div>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="no-drag absolute right-4 top-4 flex size-7 items-center justify-center rounded-full bg-on-image/20 text-on-image hover:bg-on-image/30"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </section>
  );
}
