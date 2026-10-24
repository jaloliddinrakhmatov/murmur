export interface NavLink {
  label: string;
  href: string;
}

export const SITE = {
  name: "Murmur",
  tagline: "Speak, and it is written. On your Mac, in every app.",
  cta: { label: "Get Murmur for Mac", href: "/download" },
} as const;

export const NAV: NavLink[] = [
  { label: "Features", href: "/#features" },
  { label: "Notetaker", href: "/#notetaker" },
  { label: "Pricing", href: "/pricing" },
  { label: "Privacy", href: "/privacy" },
  { label: "FAQ", href: "/#faq" },
];

export const FOOTER: { title: string; links: NavLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Notetaker", href: "/#notetaker" },
      { label: "Pricing", href: "/pricing" },
      { label: "Download for Mac", href: "/download" },
    ],
  },
  {
    title: "Learn",
    links: [
      { label: "How it works", href: "/#how" },
      { label: "Who it is for", href: "/#built-for" },
      { label: "Privacy by design", href: "/#privacy" },
      { label: "FAQ", href: "/#faq" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];
