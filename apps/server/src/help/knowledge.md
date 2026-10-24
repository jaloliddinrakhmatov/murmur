# Murmur help guide

This guide is the only source of facts for the website's help assistant. Everything here was checked against the app. If something is not here, it is not known: say so.

## What Murmur is

Murmur is a voice dictation app for macOS. You focus a text field in any app, hold a shortcut, speak, and release. Murmur turns the speech into text, tidies it, and puts it at your cursor. It also has a Scratchpad for quick notes, Transforms that rewrite selected text with AI, and a Notetaker that records meetings and writes notes.

Murmur is a menu-bar app. Its main window opens from the menu bar icon (Open Murmur), and optionally from the Dock.

## Availability and requirements

- Murmur is not released yet. There is no public download. The website has a waitlist: add your email on the Download page (/download). Nobody is emailed until there is something to send, and no release date has been announced.
- Requirements: a Mac with Apple silicon (the first builds are arm64 only) and macOS 13 or later.
- Recording your Mac's sound in the Notetaker needs macOS 14.2 or later. Everything else works on macOS 13.
- Windows and Linux are not supported.

## First-run setup

When Murmur opens for the first time it walks you through five stages: Get started, Permissions, Set up, Learn, Personalize.

1. Get started: a short survey about how you work. The answers stay on your Mac. You can sign in to a Murmur account here, but you do not have to.
2. Permissions: Microphone (needed). Your Mac's sound (only for the Notetaker). Accessibility (optional, for automatic pasting). Calendar (optional, for the Notetaker). macOS asks once for each.
3. Set up: choose a transcription service and paste its API key, test your microphone (you should see bars move when you speak), choose the languages you speak, and test your shortcut (the keys light up when you hold them).
4. Learn: short practice screens where you dictate into practice fields. You can skip them.
5. Personalize: a speed estimate, an estimate of time saved, and your referral code.

After setup, the sidebar shows a "Set up Murmur" checklist until three things work: microphone access, a dictation shortcut, and a transcription service. Accessibility is not on that checklist because it is optional.

## Permissions

- **Microphone** (required). Murmur only listens while you hold your dictation shortcut (or are in hands-free mode, or recording a meeting). If you refused it, open System Settings > Privacy & Security > Microphone and turn Murmur on. In Murmur: Settings > General > Microphone shows the state.
- **Accessibility** (optional). With it, Murmur pastes the text where your cursor is. Without it, dictation still works: each result is copied to the clipboard and you paste with Cmd+V. Accessibility is also needed to read a selection for Transforms and Command Mode, for Press Enter, for Auto-add to dictionary, for Context awareness and for Vibe coding. Turn it on in Settings > System > "Paste into other apps" (Allow), or in System Settings > Privacy & Security > Accessibility.
- **Your Mac's sound** (Notetaker only). Lets the Notetaker hear the other people in a call. macOS asks the first time you record with it on, never before. Needs macOS 14.2 or later.
- **Calendar** (optional). Lets the Notetaker list upcoming meetings from the macOS Calendar app. Events stay on your Mac.
- Murmur never asks for Input Monitoring.

## Transcription services and API keys

Murmur does not run its own speech recognition servers. Audio of each dictation is sent to the transcription service you choose, and it is not stored on any Murmur server. You bring your own API key from that service.

Services you can choose in Settings > Transcription (the "Transcription service" menu):

- **OpenAI** (the default; model gpt-4o-transcribe unless you set one).
- **Groq** (default model whisper-large-v3-turbo for English; for other languages Murmur uses whisper-large-v3 unless you set a model, because the turbo model gives wrong output in some languages such as Uzbek).
- **Deepgram** (default model nova-3).
- **Google Gemini** (default model gemini-3.5-transcribe; it handles about 7 minutes of audio per request). Google's free tier has strict rate limits; if you see "rate limit or credits ran out", wait or use a paid key.
- **whisper.cpp** (a local server for developers; audio then stays on your Mac).

To add a key: Settings > Transcription > Provider > API key, paste it, and save. Create the key in your account at the service (for example the Groq, OpenAI, Deepgram or Google AI Studio website). Murmur stores keys encrypted with macOS secure storage and never shows a saved key again. A key is sent only to the service it belongs to, never to Murmur's servers. You pay the service directly for what you use.

Other settings there: Model (leave empty for the default), Time limit (how long to wait for a transcript; if it takes longer the recording is kept so you can retry from History), and Status (shows whether the last dictation worked).

Murmur transcribes each dictation in one piece after you release the shortcut. Live word-by-word transcription is not available.

## Languages

Settings > General > Language. Add up to eight languages you speak. One language transcribes in that language. Several languages make the service detect the language automatically, using yours as hints. If you mostly speak a language other than English with Groq, leave the model empty (Murmur picks the right one) or choose whisper-large-v3.

## Dictating

- The default shortcut is Control+Option+Space. Hold it, speak, release. Murmur transcribes, cleans up and inserts the text.
- **Hands-free mode**: double-tap the shortcut to start, press it again to stop. Hands-free stops by itself after 20 minutes.
- **Esc** cancels a dictation and discards the recording.
- The small status bar at the bottom of the screen (the Capsule) shows what Murmur is doing. By default it is always visible; Settings > System > "Show the Murmur bar at all times" can hide it until you dictate.
- If Accessibility is on, text is pasted at the cursor. Otherwise it is copied and you press Cmd+V. Murmur restores your previous clipboard after pasting.
- If your cursor is in one of Murmur's own windows, or the front app changed while you spoke, the text is copied instead of pasted.
- Password fields: Murmur does not dictate into them. Words meant for a password field are never transcribed, kept or sent anywhere. When macOS "Secure Event Input" is on (a password prompt or some terminals hold it), Murmur will not paste either.
- Everything you dictate appears on the Dictation page (History), including failed ones.

### Changing the shortcut

Settings > General > Shortcuts > Change. Press the new keys. A shortcut must include Control, Option or Command with a key. Rules Murmur enforces:

- At most two modifiers plus one key.
- Control plus a single letter or digit is refused (it is used for editing text and in Terminal), and so is Command plus a single letter or digit (apps use those). Add Option or Shift, or use Control+Option.
- Esc alone is reserved for cancel. Shift alone with a key is refused.
- fn (Globe) and shortcuts made only of modifier keys are not supported, because they would need Input Monitoring.
- macOS-reserved shortcuts are refused. If another app already uses a combination, Murmur may report it as not active; pick another.
  The same dialog has optional extra shortcuts, all unset by default: Paste last transcript, Copy last transcript, Copy original words, Open Scratchpad, Transform view changes, Command Mode, Press Enter, and Join meeting / start Notetaker.

## Cleanup: None, Light, Medium

The Style page and Settings > AI cleanup choose the cleanup level:

- **None**: inserts exactly what the speech service returned. Your dictionary and snippets still apply.
- **Light** (the default): removes filler words, applies spoken punctuation and capitals, adds final punctuation. Runs on your Mac; nothing extra is sent anywhere.
- **Medium**: an AI service also fixes grammar, repeated words and self-corrections, keeping your words and meaning. This sends the transcript of every dictation to the AI service you choose (Groq, OpenAI, Anthropic or Google Gemini) with your API key under Settings > AI cleanup > AI service. Murmur treats the transcript as text to tidy, never as instructions, checks every result, and falls back to Light if the result looks wrong or arrives late. Medium says it "passed Murmur's quality check" only for models Murmur has tested; others show a warning.

## Style

Sidebar > Style. Pick how formal your text is for each kind of app: Personal messages (Messages, WhatsApp, Telegram, Signal, Messenger, Discord), Work messages (Slack, Microsoft Teams, Zoom, Google Chat), Email (Mail, Outlook, Spark, Superhuman, Mimestream) and Other. Choices are Formal (capitals and full stops), Casual (no final full stop) and Very casual (lowercase sentence starts, no final full stop; "I", acronyms and dictionary words keep capitals). Styles apply after cleanup, and not when cleanup is None.

## Dictionary and Snippets

- **Dictionary** (sidebar): words, names and terms written exactly as you spell them. Optionally add "Often heard as" to replace a wrong spelling. Up to 100 words are also sent to your transcription service as vocabulary hints (switch off in Settings > Dictionary & snippets).
- **Snippets** (sidebar): a spoken trigger phrase (for example "my email") that inserts saved text. Matched as whole words, ignoring capitals. There is a "Try it" box to test.
- **Auto-add to dictionary** (Settings > System > Extras, off by default): after a paste, Murmur re-reads only the dictated text in the same field, once, within two minutes, and adds words you re-spelled. Needs Accessibility.
- **Context awareness** (Settings > Data and Privacy, off by default): when you dictate, Murmur reads a little text around the cursor to find names and sends those names to your transcription service as spelling hints for that dictation. Never a password field. Nothing is kept.

## Transforms

Sidebar > Transforms (Beta). Rewrite text you select, only when you ask, using your AI service.

1. Turn on "Opt in" (off by default; the shortcuts are only registered while it is on).
2. Select text in any app, then press a Transform's shortcut: Control+Option+1 for Polish, Control+Option+2 for Prompt Engineer. You can create your own Transforms and change shortcuts.
3. Murmur sends only the selected text to your AI service and shows the result in a small panel. Nothing changes yet.
4. Choose Replace to put the result in place of your selection, or Copy result. Murmur checks the selection did not change first.
   Reading a selection needs Accessibility. Without it, copy the text and choose "Use copied text". Some apps (Telegram, some Electron and web apps) do not share their selection; Murmur then copies the selection for you with Cmd+C, and the result can be copied but not replaced. Password fields and password managers are never read.
   The first time you use an AI service for Transforms, Murmur asks your consent to send text to it. The AI service and key are the ones in Settings > AI cleanup.

## Command Mode

An optional shortcut (set in Settings > General > Shortcuts > Command Mode). Select text, hold the shortcut and say what to do ("make it formal", "translate to Russian"). The result opens in the Transform panel with Replace and Copy. With nothing selected it answers what you asked (Copy only). It uses the AI service and consent of Transforms. Your spoken instruction is not saved to History.

## Press Enter

An optional shortcut that presses Return in the front app, for sending a message. During a hands-free dictation it stops the dictation and presses Return only after the text was really pasted. Needs Accessibility.

## Scratchpad

Sidebar > Scratchpad. Quick notes kept on your Mac, in a floating note window. Notes autosave and keep earlier versions. Dictating while the Scratchpad is in front puts text straight at the note's cursor. There is an optional shortcut to open it from any app (Settings > General > Shortcuts > Open Scratchpad). AI edits happen only when you ask, after you agree to send the text to your AI service.

## Notetaker (meeting notes)

Sidebar > Notetaker. Write notes during a meeting and, if you want, have Murmur record and transcribe it.

- Set up Notetaker first (about 2 minutes, six steps). It explains what Murmur can hear, where meetings are kept and which services it uses, and asks you to confirm you will tell people before recording them.
- Recording starts only when you press Start. The menu bar, the Murmur bar and the Notetaker page show it while it runs. There is no hidden recording. You cannot dictate while a meeting records.
- Murmur can record your microphone and your Mac's sound (the other people in a call, but also music and any other sound). With "Label speakers (You and Others)" on (the default) the transcript is split into You and Others; it uses about twice the requests.
- Audio is sent to your transcription service in five-minute batches and deleted from your Mac once the transcript is saved.
- Summaries are made only when you ask, and only after you agree to send the transcript and notes to your AI service. The meeting-summary consent is separate from the one for Transforms.
- Meetings are stored only on your Mac. Settings > Notetaker sets how long they are kept, the maximum recording length (recording stops by itself, with a warning a minute before), and imports .txt or .md notes.
- Calendar: Settings > Connectors can read your macOS Calendar to list upcoming meetings and, if you turn it on, show a notice a minute before a meeting with a Zoom, Google Meet or Teams link. It never starts recording by itself.
- Recording your Mac's sound needs macOS 14.2 or later and a separate macOS permission (System Audio Recording).

## History (the Dictation page)

Sidebar > Dictation holds your history: search, sort, copy, delete and retry. Failed dictations keep their encrypted recording so you can retry. Settings > Data and Privacy > History:

- Keep History on this Mac (on by default). If off, new dictations are not saved.
- Delete dictations after (a time you choose, or never).
- Keep recordings of failed dictations (encrypted, deleted once a dictation is inserted).
- Keep recordings so I can play them back (off by default). If on, every inserted dictation's encrypted recording stays on your Mac for the retention period and a Play button appears on the row. Never kept for password fields.
- Export (History, dictionary, snippets and Notetaker meetings as one JSON file) and Delete all History.
- Reset Murmur (Settings > System > Data) deletes settings, History, recordings and API keys and starts setup again.

## Insights

Sidebar > Insights. Words per minute, fixes Murmur made, total words, apps you dictate into, and your day streak, all worked out on your Mac from your History. If History is off there is nothing to show. No figures are invented.

## Integrations

- **MCP** (Settings > MCP, off by default): lets AI apps on your Mac, such as Claude Desktop, read your Notetaker meetings (titles, times, notes, transcripts, summaries). It runs a server on 127.0.0.1 only while Murmur is open, every request needs an access token you create, and the apps cannot change anything. They never see dictations, History, Scratchpad notes, audio, settings or keys. Cloud apps such as ChatGPT cannot connect, because Murmur has no hosted service.
- **Connectors** (Settings > Connectors): macOS Calendar works. Direct connections to Google Calendar, Outlook and Slack are not available yet.
- **Vibe coding** (Settings > Vibe coding, both options off by default): only in VS Code, Cursor and Windsurf. File tagging turns "at index dot tsx" into @index.tsx. Variable recognition writes spoken names like "user name" as the identifier near your cursor (userName). Needs Accessibility. Nothing read is kept.

## Account, teams and referrals

An account is optional. Dictation, Notetaker and everything else work without one; nothing contacts Murmur's server until you sign in.

- Sign in: Settings > Account, with an email address. Murmur emails you a six-digit code (valid for 10 minutes).
- What the account sends: your daily word count (a number, never what you said). Dictations, audio, notes and meetings stay on your Mac.
- **Invite your team** (sidebar): creating a team starts a 14-day Pro trial for everyone in it. Each person gets a code by email (valid 14 days) and joins at Settings > Team by pasting the code. Settings > Team lets owners rename the team, remove members and revoke invites; the owner cannot leave the team.
- **Get a free month** (sidebar): share your referral code. A friend who applies your code gets one month of Pro right away (the code must be applied within 30 days of their account being created, and never your own). You get one month when the friend has dictated 2,000 words, on at least 3 different days, and their account is at least 3 days old. Progress is shown in the Refer dialog. The number of rewards per year is limited, so months cannot be farmed.
- **Plans and Billing** (Settings): shows your plan, referral credit and promo codes. Plan names are Free, Pro and Enterprise. Prices and plan details are not final, so do not quote any price; the website's pricing page (/pricing) shows the current draft.
- Sign out or delete the account in Settings > Account. Deleting removes the account, team membership and referrals from the server; your dictations and settings on your Mac are not touched.

## Privacy

- Audio goes only to the transcription service you chose. With whisper.cpp on a local address it stays on your Mac.
- Transcripts go to an AI service only if you use Medium cleanup, Transforms, Command Mode, Scratchpad AI edits or Notetaker summaries, and each of the last three asks your consent first.
- History, dictionary, snippets, settings and encrypted recordings stay on your Mac. There is no cloud History. Murmur does not use your audio, transcripts or edits to train or evaluate any model. Murmur's servers never receive them.
- API keys are stored encrypted with macOS secure storage.
- The website and the full policy: /privacy and /terms. Settings > Data and Privacy > "What leaves this Mac" lists exactly what is sent, based on your settings.

## Troubleshooting

**Nothing happens when I hold the shortcut.** Open the Murmur window: the sidebar checklist or Settings > General > Shortcuts shows "Not active" with a reason if the shortcut could not be registered. Another app may use the same keys; choose another combination. If macOS reserved it, pick another. If Murmur is not running, open it from Applications; its icon should be in the menu bar.

**The microphone does not work.** Settings > General > Microphone: check the status and pick the right device (it shows a level meter). If access is "Off", open System Settings > Privacy & Security > Microphone and turn Murmur on, then try again. In development builds macOS lists the app as "Electron".

**Text was not pasted.** Without Accessibility Murmur only copies: press Cmd+V. To paste automatically, turn on Accessibility (Settings > System > Paste into other apps > Allow). The text is also copied when the front app changed while you spoke, when your cursor was in Murmur's own window, and never inserted in password fields or while macOS Secure Event Input is on. The last dictation is always on the Dictation page; use the Paste last transcript shortcut if you set one.

**"The transcription service didn't accept your API key" (401/403).** The key is wrong, expired or lacks access. Create a new key at the service and paste it in Settings > Transcription. Never share a key; if you pasted one anywhere public, revoke it and make a new one.

**"Rate limit or credits ran out" (429/402).** Your service account has run out of credits or hit its rate limit. Wait, add credit, or switch service. Google Gemini's free tier is limited.

**"The transcription model wasn't found" (404).** Clear the Model field in Settings > Transcription to use the default, or enter a model the service offers.

**"Murmur couldn't reach the transcription service".** Check your internet connection. The recording is kept; retry from the Dictation page.

**"The transcription service didn't answer in time".** Raise Time limit in Settings > Transcription, or retry. A recording that is too long for the service ("too long") needs another service.

**Odd or wrong words in another language.** Set your languages in Settings > General > Language. With Groq, leave Model empty so Murmur uses whisper-large-v3 for non-English.

**"Can't reach Murmur's server".** This is about the optional account (sign-in, team, referrals, plans). Check your connection and press Try again. Dictation and everything on your Mac keep working.

**AI cleanup fell back to Light.** The AI service was late, unreachable or its answer failed Murmur's checks. Settings > AI cleanup > Status shows the last outcome and any missing key.

**Transforms do nothing.** Check Opt in is on, the AI service key is set, and Accessibility is allowed; select text first. Some apps need the copy fallback.

**Notetaker will not record Mac sound.** Needs macOS 14.2+, "Record your Mac's sound" on in Settings > Notetaker, and the System Audio Recording permission in System Settings > Privacy & Security.

## Contact

For anything this guide does not cover, contact: [Contact email]
