import { HeroCopy } from "./hero-copy.tsx";
import { HeroDemo } from "../hero-demo.tsx";
import { VoiceField } from "./voice-field.tsx";
import { Marquee } from "./marquee.tsx";

export function Hero() {
  return (
    <section className="relative isolate overflow-x-clip pt-10 pb-20 sm:pt-16">
      <VoiceField />
      <div
        className="dotgrid absolute inset-x-0 top-0 -z-10 h-[34rem]"
        aria-hidden="true"
      />
      <div className="container-m text-center">
        <HeroCopy />
        <div className="mt-14">
          <HeroDemo />
        </div>
      </div>
    </section>
  );
}

export function AppsStrip() {
  return (
    <section
      aria-labelledby="apps-title"
      className="border-y border-hairline bg-surface/50 py-10"
    >
      <h2
        id="apps-title"
        className="text-center text-sm font-semibold text-muted"
      >
        Works wherever you can type
      </h2>
      <Marquee />
    </section>
  );
}
