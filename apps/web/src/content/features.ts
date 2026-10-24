export type IconName =
  | "mic"
  | "wand"
  | "brush"
  | "book"
  | "rewrite"
  | "pad"
  | "users"
  | "command"
  | "code"
  | "plug"
  | "globe"
  | "history"
  | "lock"
  | "mail"
  | "chat"
  | "doc"
  | "terminal"
  | "browser"
  | "notes"
  | "board"
  | "sun"
  | "moon"
  | "check"
  | "chevron"
  | "gift"
  | "play"
  | "pen"
  | "chart";

export interface Feature {
  id: string;
  icon: IconName;
  title: string;
  body: string;
  /** Wide cards span two columns on large screens. */
  wide?: boolean;
}

export const FEATURES: Feature[] = [
  {
    id: "dictation",
    icon: "mic",
    title: "Dictation anywhere",
    body: "Hold your shortcut, speak, release. The text is pasted at your cursor in whatever app you are using, so there is no special window to switch to.",
    wide: true,
  },
  {
    id: "cleanup",
    icon: "wand",
    title: "Cleanup that keeps your words",
    body: "Fillers and false starts go, punctuation arrives. Choose Light or Medium AI cleanup; it is guarded so what you said is never treated as an instruction.",
  },
  {
    id: "styles",
    icon: "brush",
    title: "Styles for each kind of app",
    body: "Formal in mail, casual in chat, very casual with friends. Murmur picks the tone from the app you are typing into.",
  },
  {
    id: "dictionary",
    icon: "book",
    title: "Dictionary",
    body: "Teach it names, products and jargon once, and Murmur spells them your way from then on.",
  },
  {
    id: "snippets",
    icon: "doc",
    title: "Snippets",
    body: "Say a short phrase and expand it into your address, a link or a whole paragraph.",
  },
  {
    id: "transforms",
    icon: "rewrite",
    title: "Transforms",
    body: "Select text, press a shortcut, and rewrite it with a saved prompt such as Polish. You review the result before it replaces anything.",
  },
  {
    id: "notetaker",
    icon: "users",
    title: "Notetaker",
    body: "Take meeting notes while Murmur transcribes your microphone and your Mac's sound, labelled You and Others, with a summary when you ask for one.",
    wide: true,
  },
  {
    id: "command",
    icon: "command",
    title: "Command Mode",
    body: "Select a passage, hold the shortcut and say what to do with it: shorter, friendlier, in French. The answer appears in a panel for you to accept.",
  },
  {
    id: "scratchpad",
    icon: "pad",
    title: "Scratchpad",
    body: "A floating note that autosaves with revisions. Dictate straight into it, and ask AI for edits only when you want them.",
  },
  {
    id: "vibe",
    icon: "code",
    title: "Vibe coding",
    body: "Say a file name and get an @file tag. Dictate variable names in camelCase or snake_case without fixing them by hand.",
  },
  {
    id: "mcp",
    icon: "plug",
    title: "MCP for meeting notes",
    body: "Let an AI app such as Claude Desktop read your meeting notes through a local connection that is off until you turn it on.",
  },
  {
    id: "languages",
    icon: "globe",
    title: "100+ languages",
    body: "Dictate in more than a hundred languages, including Uzbek, and mix languages in one sentence. Accuracy depends on the transcription service you choose.",
    wide: true,
  },
  {
    id: "history",
    icon: "history",
    title: "History with playback",
    body: "Every dictation is searchable on your Mac. Replay the audio, copy the text again, or try a different transform.",
  },
];
