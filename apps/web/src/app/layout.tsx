import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Footer } from "../components/footer.tsx";
import { HelpWidget } from "../components/help/help-widget.tsx";
import { Header } from "../components/header.tsx";
import { sans, serif } from "../lib/fonts.ts";
import { PageTransitions } from "../motion/page-transitions.tsx";
import { PointerGlow } from "../motion/pointer-glow.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Murmur: voice typing for your Mac",
    template: "%s | Murmur",
  },
  description:
    "Hold a shortcut, speak, and clean text appears at your cursor in any Mac app. Private by design, with an optional account.",
  applicationName: "Murmur",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f1" },
    { media: "(prefers-color-scheme: dark)", color: "#121014" },
  ],
};

// Theme first (no flash), then the motion flag: .m-js hides only content that a component will
// animate in, and is removed after 3.5 s so nothing stays hidden if scripts never arrive.
const THEME_SCRIPT = `try{var t=localStorage.getItem("murmur.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}try{if(!matchMedia("(prefers-reduced-motion: reduce)").matches){var h=document.documentElement;h.classList.add("m-js");setTimeout(function(){h.classList.remove("m-js")},3500)}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${serif.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-fg"
        >
          Skip to content
        </a>
        <Header />
        <main id="main">{children}</main>
        <Footer />
        <PointerGlow />
        <PageTransitions />
        <HelpWidget />
      </body>
    </html>
  );
}
