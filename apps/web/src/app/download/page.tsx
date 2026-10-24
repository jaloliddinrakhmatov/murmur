import type { Metadata } from "next";
import { DownloadArt } from "../../components/download-art.tsx";
import { Icon } from "../../components/icons.tsx";
import { Reveal } from "../../motion/reveal.tsx";
import { SplitHeading } from "../../motion/split-heading.tsx";
import { WaitlistForm } from "../../components/waitlist-form.tsx";

export const metadata: Metadata = {
  title: "Download",
  description:
    "Murmur for Mac is almost ready. Leave your email to be told when it is available.",
};

const REQUIREMENTS = [
  "A Mac with Apple silicon (the first builds are arm64 only).",
  "macOS 13 or later. Recording your Mac's sound in the Notetaker needs macOS 14.2 or later.",
];

const NEEDS = [
  {
    title: "Microphone permission",
    body: "macOS asks the first time you dictate. Murmur only listens while you hold the shortcut or record a meeting.",
  },
  {
    title: "Accessibility (optional)",
    body: "Lets Murmur paste the text for you. Without it, the text is copied and you paste it yourself.",
  },
  {
    title: "A transcription service",
    body: "You bring your own API key from a supported service, such as Groq, OpenAI, Deepgram or Google Gemini. Murmur stores the key encrypted on your Mac, and your audio goes to that service only.",
  },
];

export default function Page() {
  return (
    <div className="container-m py-16 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <Reveal eager>
          <p className="eyebrow">Download</p>
        </Reveal>
        <SplitHeading
          as="h1"
          eager
          className="display mt-3 text-5xl sm:text-6xl"
        >
          Murmur for Mac is <em>almost ready</em>
        </SplitHeading>
        <Reveal eager delay={0.3}>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            There is no signed download yet. Leave your email and we&rsquo;ll
            tell you when there is.
          </p>
          <div className="mt-8 flex justify-center">
            <WaitlistForm source="download" compact />
          </div>
        </Reveal>
      </div>
      <DownloadArt />

      <Reveal
        stagger={0.12}
        className="mx-auto mt-20 grid max-w-4xl items-start gap-5 md:grid-cols-2"
      >
        <section data-lift="" className="card p-7" aria-labelledby="req">
          <h2 id="req" className="font-serif text-3xl">
            System requirements
          </h2>
          <ul className="mt-5 space-y-3">
            {REQUIREMENTS.map((r) => (
              <li key={r} className="flex gap-3">
                <Icon
                  name="check"
                  size={20}
                  className="mt-0.5 shrink-0 text-accent-text"
                />
                {r}
              </li>
            ))}
          </ul>
        </section>
        <section data-lift="" className="card p-7" aria-labelledby="need">
          <h2 id="need" className="font-serif text-3xl">
            What you need
          </h2>
          <ul className="mt-5 space-y-4">
            {NEEDS.map((n) => (
              <li key={n.title}>
                <h3 className="font-semibold">{n.title}</h3>
                <p className="mt-1 leading-relaxed text-muted">{n.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </Reveal>
    </div>
  );
}
