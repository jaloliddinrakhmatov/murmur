"use client";

import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

// Registered once for the whole site; every animated component imports from here.
gsap.registerPlugin(
  useGSAP,
  ScrollTrigger,
  ScrollToPlugin,
  SplitText,
  DrawSVGPlugin,
  MorphSVGPlugin,
);

// The mobile address bar growing and shrinking must not re-measure every trigger.
ScrollTrigger.config({ ignoreMobileResize: true });

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
export const MOTION_OK = "(prefers-reduced-motion: no-preference)";

export {
  DrawSVGPlugin,
  MorphSVGPlugin,
  ScrollTrigger,
  SplitText,
  gsap,
  useGSAP,
};
