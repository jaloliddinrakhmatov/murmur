import type { IconName } from "./features.ts";

export const STEPS = [
  {
    n: "1",
    label: "Hold",
    title: "Hold your shortcut",
    body: "Press and hold Control, Option and Space, or record your own. The Murmur bar appears and the microphone opens.",
  },
  {
    n: "2",
    label: "Speak",
    title: "Talk the way you think",
    body: "Pauses, ums and restarts are fine. The bar shows that Murmur is listening for as long as the keys are down.",
  },
  {
    n: "3",
    label: "Clean up",
    title: "Fillers go, punctuation arrives",
    body: "Murmur strikes the ums, fixes capitals and adds the full stop. What you said stays what you said.",
  },
  {
    n: "4",
    label: "Style",
    title: "Tone that fits the app",
    body: "Formal for email, casual for chat. Pick a style for each kind of app and Murmur applies it as you finish.",
  },
  {
    n: "5",
    label: "Lands",
    title: "The text lands at your cursor",
    body: "Let go and the words are pasted where you were typing, in any app. Undo works like it always does.",
  },
  {
    n: "6",
    label: "Saved",
    title: "Kept on your Mac",
    body: "Each dictation joins your History, searchable and on this Mac, so you can copy it again or replay the audio if you chose to keep it.",
  },
] as const;

export const TEAM_POINTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "users",
    title: "Create a team",
    body: "Name it in Settings, then invite people by email. A team starts with a 14-day Pro trial.",
  },
  {
    icon: "mail",
    title: "Invite by email or code",
    body: "Teammates sign in with the invited address, or paste the team code under Join a team.",
  },
  {
    icon: "gift",
    title: "Get a free month",
    body: "Share your referral code. Your friend gets a month of Pro, and you get one when they have dictated 2,000 words.",
  },
];

export const PRIVACY: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "lock",
    title: "Your library stays on your Mac",
    body: "Dictations, History, notes and meetings are stored locally. Saved audio is encrypted with a key kept in your Keychain.",
  },
  {
    icon: "mic",
    title: "Audio goes only where you send it",
    body: "Audio is sent to the transcription service you choose, and nowhere else. Murmur keeps no audio on its own servers.",
  },
  {
    icon: "check",
    title: "No training on your data",
    body: "Murmur never trains models on what you say or write. Your chosen providers have their own policies, so read theirs too.",
  },
  {
    icon: "users",
    title: "An account is optional",
    body: "Nothing contacts Murmur's servers until you sign in. Accounts exist for teams, referrals and billing, not for dictating.",
  },
  {
    icon: "doc",
    title: "Password fields are off limits",
    body: "Murmur never reads the contents of a password field and never transcribes a dictation made in one.",
  },
  {
    icon: "plug",
    title: "Integrations are off by default",
    body: "The MCP connection, calendar access and Transforms stay switched off until you turn them on, and each AI service needs your consent first.",
  },
];

export const PERSONAS = [
  {
    scene: "writers",
    who: "Writers",
    line: "Get the first draft out of your head before it cools.",
    example:
      "Dictate a messy page, then Polish it into something you can edit.",
  },
  {
    scene: "developers",
    who: "Developers",
    line: "Explain the change without leaving the editor.",
    example:
      "“Update @auth middleware to check the session token” becomes a tagged, ready-to-send prompt.",
  },
  {
    scene: "support",
    who: "Support teams",
    line: "Answer faster and keep a human voice.",
    example:
      "Snippets hold your greetings and links; dictation handles the part that is different each time.",
  },
  {
    scene: "students",
    who: "Students",
    line: "Capture the thought while you are still having it.",
    example:
      "Talk through a reading in the Scratchpad, then tidy it up when you sit down to write.",
  },
  {
    scene: "managers",
    who: "Managers",
    line: "Be in the meeting, not in the notes.",
    example:
      "Start the Notetaker, listen, and ask for a summary of decisions afterwards.",
  },
] as const;

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Which apps does Murmur work in?",
    a: "Any app where you can place a text cursor. Murmur pastes the result at the cursor, so mail, chat, documents, browsers, editors and terminals all work. Allowing Accessibility lets Murmur paste for you; setup itself only needs the microphone, a shortcut and a transcription service.",
  },
  {
    q: "Where does my voice go?",
    a: "To the transcription service you pick in Settings, over an encrypted connection, and nowhere else. Murmur does not store audio on its own servers. If you keep audio in History, it is encrypted on your Mac.",
  },
  {
    q: "Do I need an account?",
    a: "No. You can use Murmur without ever signing in, and nothing contacts Murmur's servers until you do. Accounts are for team invites, referrals and billing.",
  },
  {
    q: "Will AI cleanup change what I said?",
    a: "Cleanup removes fillers and fixes punctuation and casing. It is tested against inputs that try to give it instructions, and it is built so your words are not treated as commands. You can turn it down to Light, or off, in Settings.",
  },
  {
    q: "Does the Notetaker record meetings on its own?",
    a: "Never. It records only after you press Start, shows a clear indicator while it runs, and asks for macOS permission before it can hear your Mac's sound. When the transcript is saved, the audio is deleted. Summaries are written only on request and after you consent to the AI service.",
  },
  {
    q: "Can my team use Murmur together?",
    a: "Yes. Create a team in Settings, invite people by email or share the team code, and the team starts with a 14-day Pro trial. Sharing a dictionary across a team is planned but is not in the app yet.",
  },
  {
    q: "Which languages are supported?",
    a: "More than a hundred, including Uzbek, and you can mix languages in one dictation. How well a language is recognised depends on the transcription service you choose, so try your own voice first.",
  },
  {
    q: "Can I change the shortcut?",
    a: "Yes. The default is Control + Option + Space, and you can record any combination with a modifier and a key. Murmur refuses combinations that would collide with common shortcuts such as Command + C.",
  },
  {
    q: "Is Murmur free? Where do I download it?",
    a: "There is a Free plan, and the Pricing page shows the plans (prices are not final). The download is not out yet: leave your email on the Download page and we will tell you when it is.",
  },
  {
    q: "Is the help chat on this site private?",
    a: "What you type goes to Murmur's server and to the AI service that writes the answer. Murmur does not store or log the conversation, and it stays in your browser tab until you close it or start a new chat. AI answers can be wrong, so please don't type passwords or API keys.",
  },
  {
    q: "Which platforms are supported?",
    a: "macOS only, for now. Other platforms are not available.",
  },
];
