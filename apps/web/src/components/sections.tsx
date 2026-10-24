import { Heading } from "./story/heading.tsx";
import { FeatureBento } from "./story/bento.tsx";

export { Faq } from "./story/faq.tsx";
export { Notetaker } from "./story/notetaker.tsx";
export { BuiltFor } from "./story/personas.tsx";
export { Privacy } from "./story/privacy.tsx";
export { RevealController } from "./story/reveal.tsx";
export { SpeedRace } from "./story/speed-race.tsx";
export { Teams } from "./story/teams.tsx";
export { VoiceStory as How } from "./story/voice-story.tsx";

export function Features() {
  return (
    <section id="features" className="container-m py-24 sm:py-32">
      <Heading
        eyebrow="Features"
        sub="One shortcut at the centre, and a set of quiet tools around it for the work you do after the words are down."
      >
        Everything around the <em>voice</em>
      </Heading>
      <div className="mt-14">
        <FeatureBento />
      </div>
    </section>
  );
}
