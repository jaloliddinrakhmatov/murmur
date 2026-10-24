// Writing styles per kind of app (Stage E part 2, Style page tabs). Murmur sorts the app you
// dictate into by its bundle id; anything not listed is "Other". The styles themselves are
// `applyStyle` in @murmur/text.
import type { WritingStyle } from "@murmur/text";

export const APP_CATEGORIES = ["personal", "work", "email", "other"] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<AppCategory, string> = {
  personal: "Personal messages",
  work: "Work messages",
  email: "Email",
  other: "Other",
};

/** Bundle ids by category, with the names shown on the Style page. */
export const CATEGORY_APPS: Record<
  Exclude<AppCategory, "other">,
  { id: RegExp; name: string }[]
> = {
  personal: [
    { id: /^com\.apple\.MobileSMS$/, name: "Messages" },
    { id: /^(net\.whatsapp\.WhatsApp|desktop\.WhatsApp)$/, name: "WhatsApp" },
    {
      id: /^(ru\.keepcoder\.Telegram|com\.tdesktop\.Telegram)$/,
      name: "Telegram",
    },
    { id: /^org\.whispersystems\.signal-desktop$/, name: "Signal" },
    { id: /^com\.facebook\.archon/, name: "Messenger" },
    { id: /^com\.hnc\.Discord$/, name: "Discord" },
  ],
  work: [
    { id: /^com\.tinyspeck\.slackmacgap$/, name: "Slack" },
    { id: /^com\.microsoft\.teams2?$/, name: "Microsoft Teams" },
    { id: /^us\.zoom\.xos$/, name: "Zoom" },
    { id: /^com\.google\.Chat/, name: "Google Chat" },
  ],
  email: [
    { id: /^com\.apple\.mail$/, name: "Mail" },
    { id: /^com\.microsoft\.Outlook$/, name: "Outlook" },
    { id: /^com\.readdle\.smartemail/, name: "Spark" },
    { id: /^com\.superhuman\./, name: "Superhuman" },
    { id: /^com\.mimestream\.Mimestream$/, name: "Mimestream" },
  ],
};

export function categoryFor(bundleId: string | null | undefined): AppCategory {
  if (!bundleId) return "other";
  for (const [category, apps] of Object.entries(CATEGORY_APPS))
    if (apps.some((a) => a.id.test(bundleId))) return category as AppCategory;
  return "other";
}

export const WRITING_STYLES: WritingStyle[] = [
  "formal",
  "casual",
  "veryCasual",
];
