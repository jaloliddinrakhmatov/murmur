import localFont from "next/font/local";

export const sans = localFont({
  src: "../fonts/Figtree-Variable.ttf",
  weight: "300 900",
  variable: "--font-sans",
  display: "swap",
});

export const serif = localFont({
  src: [
    {
      path: "../fonts/EBGaramond-Variable.ttf",
      weight: "400 800",
      style: "normal",
    },
    {
      path: "../fonts/EBGaramond-Italic-Variable.ttf",
      weight: "400 800",
      style: "italic",
    },
  ],
  variable: "--font-serif",
  display: "swap",
});
