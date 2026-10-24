import type { DemoScript } from "../lib/demo.ts";

export const HERO = {
  eyebrow: "Voice typing for macOS",
  titleStart: "Say it once.",
  titleAccent: "Murmur",
  titleEnd: "writes it down.",
  sub: "Hold a shortcut, talk the way you think, let go. Clean, punctuated text appears right where your cursor is, in any app on your Mac.",
  primary: { label: "Get Murmur for Mac", href: "/download" },
  secondary: { label: "See how it works", href: "#how" },
  note: "macOS only for now. Your account is optional.",
} as const;

export const DEMO_SCRIPTS: DemoScript[] = [
  {
    id: "mail",
    app: "Mail",
    style: "Formal",
    spoken:
      "hi Amara um the review moved to Friday afternoon let me know if that works for you",
    written:
      "Hi Amara, the review has moved to Friday afternoon. Let me know if that works for you.",
  },
  {
    id: "chat",
    app: "Messages",
    style: "Casual",
    spoken: "running ten minutes late grab me a table by the window",
    written: "Running ten minutes late, grab me a table by the window.",
  },
  {
    id: "uz",
    app: "Notes",
    style: "Uzbek",
    spoken:
      "salom Dilnoza ertangi uchrashuvni soat uchga ko'chirdik qulay bo'lsa tasdiqlab yuboring",
    written:
      "Salom Dilnoza, ertangi uchrashuvni soat uchga ko'chirdik. Qulay bo'lsa, tasdiqlab yuboring.",
  },
];

export const APP_KINDS = [
  { icon: "mail", label: "Email" },
  { icon: "chat", label: "Messaging" },
  { icon: "doc", label: "Documents" },
  { icon: "code", label: "Code editors" },
  { icon: "terminal", label: "Terminals" },
  { icon: "browser", label: "Browsers" },
  { icon: "notes", label: "Notes" },
  { icon: "board", label: "Project tools" },
] as const;
