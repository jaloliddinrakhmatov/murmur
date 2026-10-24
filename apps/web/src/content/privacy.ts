import { RULES } from "@murmur/account-api";
import type { LegalDoc } from "./legal-types.ts";

export const PRIVACY_DOC: LegalDoc = {
  eyebrow: "Legal",
  title: "Privacy policy",
  updated: "2026-10-21",
  sections: [
    {
      id: "who",
      title: "Who we are",
      blocks: [
        {
          p: "Murmur is a voice typing app for Mac, made by [Company name], [Company address]. This policy covers the Murmur app, this website and the optional Murmur account. Questions: [Contact email].",
        },
        {
          p: "The short version: the app works on your Mac. Murmur's own servers hold only the little that an optional account needs, and never your dictations, audio, notes or transcripts.",
        },
      ],
    },
    {
      id: "on-your-mac",
      title: "What stays on your Mac",
      blocks: [
        {
          p: "Without an account, Murmur contacts none of our servers. These are stored only on your Mac:",
        },
        {
          ul: [
            "Your dictation history, dictionary, snippets, notes (Scratchpad), saved transforms and meetings, in a local database.",
            "Your settings, and your API keys, which are encrypted with the macOS Keychain.",
            "Audio you choose to keep (for example History playback, or a meeting being recorded), encrypted with a key held in your Keychain. Meeting audio is deleted once its transcript is saved. Audio kept for retries or playback is deleted after the retention period you set.",
          ],
        },
        {
          p: "Murmur never reads the contents of a password field and never transcribes a dictation made in one.",
        },
      ],
    },
    {
      id: "services",
      title: "Services you choose",
      blocks: [
        {
          p: "Murmur sends data to a third-party service only when you set one up, using your own API key.",
        },
        {
          ul: [
            "Transcription: the audio of each dictation (and, in the Notetaker, of a meeting) goes to the transcription service you pick, such as Groq, OpenAI, Deepgram or Google Gemini. Murmur does not keep a copy on its servers.",
            "AI features (cleanup, transforms, Scratchpad edits, meeting summaries): the text involved goes to the AI service you pick, only after you consent to that service. These features are off until you turn them on.",
            "Optional context features, such as reading a few hundred characters around the cursor to improve spelling, are off by default and the text is not kept.",
          ],
        },
        {
          p: "Those services have their own privacy policies and retention rules, which apply to what you send them. Read theirs too. Murmur does not train models on your data.",
        },
      ],
    },
    {
      id: "account",
      title: "Your Murmur account (optional)",
      blocks: [
        {
          p: "An account is only for teams, referrals and billing. Nothing contacts our server until you sign in. When you do, the server stores:",
        },
        {
          ul: [
            "Your email address, and your first and last name and profile picture if you add them.",
            "Sign-in codes (stored hashed, valid 10 minutes) and sign-in sessions for each device: device name, platform, app version and when it was last used.",
            "Your referral code, referrals you made or used, and free-month credit.",
            "Your team, your role and the invitations you sent or received (the invited address and a hashed invite code).",
            "A daily word count, a single number per day, used for plan limits and referral rewards. Never the words themselves.",
            "Your plan and subscription status. [Payment provider] will handle card details; we will not store them.",
            "Records used to limit abuse, such as hashed email addresses and counts of recent sign-in attempts.",
          ],
        },
        {
          p: "We use this to run your account, send the emails you ask for (sign-in codes, invitations), apply plans and referral rewards, and prevent abuse.",
        },
      ],
    },
    {
      id: "website",
      title: "This website and the waitlist",
      blocks: [
        {
          p: "This site does not use advertising or analytics cookies. It stores one preference in your browser (light or dark theme).",
        },
        {
          p: "If you join the waitlist we store your email address as you typed it, a hashed copy used to ignore repeats, which form you used, and the date. We use it to tell you when Murmur for Mac is available, and for nothing else. To be removed, write to [Contact email].",
        },
        {
          p: "Referral and invite pages ask our server whether a code is valid, and show only a first name or a team name. They do not show anyone's email address.",
        },
        {
          p: "Our server may briefly use your IP address to limit repeated requests. [Hosting provider] will host the site and server; we will name it here before launch.",
        },
      ],
    },
    {
      id: "help-chat",
      title: "Help chat",
      blocks: [
        {
          p: "This website has an AI help chat (the round button at the bottom right). It is optional and does nothing until you open it and send a message.",
        },
        {
          ul: [
            "What you type is sent to Murmur's server and from there to the AI service that writes the answer. We also send the kind of page you are on (for example Pricing or Download), never its address.",
            "Murmur does not store or log the conversation on its server. The AI service that writes the answers has its own privacy policy and retention rules, which apply to what it receives.",
            "The conversation stays in this browser tab until you close the tab or start a new chat. It is not kept anywhere else and is not used to train models.",
            "To limit abuse, the server may briefly use your IP address to count requests, as it does for the rest of this site.",
          ],
        },
        {
          p: "Answers can be wrong. Please don't type personal data, passwords or API keys into the chat.",
        },
      ],
    },
    {
      id: "sharing",
      title: "Who we share data with",
      blocks: [
        {
          p: "We do not sell your data. We share it only with providers that run the service for us, under their own terms: [Hosting provider], [Email provider] (to send sign-in codes and invitations) and [Payment provider]. We may disclose information if the law requires it.",
        },
      ],
    },
    {
      id: "retention",
      title: "How long we keep it",
      blocks: [
        {
          ul: [
            "Account data: until you delete your account. Deleting it removes your profile, devices, teams membership, usage and referrals.",
            "Anti-abuse records: a hashed form of your email address (not the address) is kept after deletion, so a free trial or a referral reward can't be claimed twice.",
            `Team invitations expire after ${RULES.teamInviteDays} days.`,
            "Waitlist entries: until we tell you Murmur is available and for a short time after, or until you ask us to remove yours.",
          ],
        },
      ],
    },
    {
      id: "rights",
      title: "Your choices and rights",
      blocks: [
        {
          p: "You can use Murmur without an account, delete your history on your Mac from Settings, and turn off every optional feature. Depending on where you live you may also have the right to access, correct, export or delete the data we hold about you, and to object to its use. Write to [Contact email] and we will answer within [response time].",
        },
      ],
    },
    {
      id: "security",
      title: "Security",
      blocks: [
        {
          p: "Data in transit uses encrypted connections. Keys and recordings on your Mac are encrypted with the macOS Keychain. No system is perfectly secure, so please keep your Mac and API keys safe.",
        },
      ],
    },
    {
      id: "children",
      title: "Children",
      blocks: [
        {
          p: "Murmur is not meant for children under [minimum age], and we do not knowingly collect their data.",
        },
      ],
    },
    {
      id: "changes",
      title: "Changes to this policy",
      blocks: [
        {
          p: "We will post changes here and update the date above. For material changes we will tell account holders by email.",
        },
      ],
    },
  ],
};
