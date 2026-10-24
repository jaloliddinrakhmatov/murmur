import { FinalCta } from "../components/hero/final-cta.tsx";
import { AppsStrip, Hero } from "../components/hero/hero.tsx";
import {
  BuiltFor,
  Faq,
  Features,
  How,
  Notetaker,
  Privacy,
  RevealController,
  SpeedRace,
  Teams,
} from "../components/sections.tsx";

export default function Home() {
  return (
    <>
      <Hero />
      <AppsStrip />
      <How />
      <Features />
      <SpeedRace />
      <Notetaker />
      <Teams />
      <Privacy />
      <BuiltFor />
      <Faq />
      <FinalCta />
      <RevealController />
    </>
  );
}
