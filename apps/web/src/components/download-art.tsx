import { DrawOnScroll } from "../motion/draw-on-scroll.tsx";

/**
 * A line drawing of a Mac with the Murmur capsule on its screen. It draws itself once, stroke by
 * stroke (DrawSVG); the finished drawing is in the server HTML. Decorative.
 */
export function DownloadArt() {
  return (
    <DrawOnScroll eager delay={0.5} className="mx-auto mt-14 max-w-xl">
      <svg
        viewBox="0 0 520 320"
        role="presentation"
        aria-hidden="true"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-auto w-full"
      >
        <g stroke="var(--m-fg)" strokeWidth="2" strokeOpacity="0.85">
          <rect data-draw x="60" y="20" width="400" height="240" rx="18" />
          <path
            data-draw
            d="M20 268h480c0 14-10 26-24 26H44c-14 0-24-12-24-26Z"
          />
          <path data-draw d="M220 268h80" strokeOpacity="0.6" />
        </g>
        <g stroke="var(--m-fg)" strokeWidth="2.5" strokeOpacity="0.35">
          <path data-draw d="M104 82h200" />
          <path data-draw d="M104 114h272" />
          <path data-draw d="M104 146h150" />
        </g>
        <g stroke="var(--m-accent)" strokeWidth="2.5">
          <path data-draw d="M266 134v24" />
          <rect data-draw x="186" y="196" width="148" height="38" rx="19" />
          <path
            data-draw
            d="M232 207v16M242 212v6M252 205v20M262 210v10M272 207v16"
          />
        </g>
        <circle data-fill cx="206" cy="215" r="6" fill="var(--m-accent)" />
      </svg>
    </DrawOnScroll>
  );
}
