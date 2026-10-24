import Link from "next/link";
import { SITE } from "../../content/site.ts";
import { Magnetic } from "../../motion/magnetic.tsx";
import { Reveal } from "../../motion/reveal.tsx";
import { SplitHeading } from "../../motion/split-heading.tsx";
import { WaitlistForm } from "../waitlist-form.tsx";
import { Aurora } from "./aurora.tsx";

export function FinalCta() {
  return (
    <section className="container-m pb-24">
      <Aurora className="rounded-[2rem] bg-night px-6 py-20 text-center text-night-fg sm:py-28">
        <SplitHeading
          chars
          className="display relative mx-auto max-w-2xl text-4xl sm:text-6xl"
        >
          Your next email is <em className="!text-[#ffa06b]">one breath</em>{" "}
          away
        </SplitHeading>
        <Reveal delay={0.15}>
          <p className="relative mx-auto mt-5 max-w-md text-night-muted">
            Try voice typing that stays out of your way.
          </p>
          <Magnetic className="mt-8 inline-block">
            <Link
              href={SITE.cta.href}
              className="btn btn-sheen relative bg-night-fg text-night hover:bg-white"
            >
              {SITE.cta.label}
            </Link>
          </Magnetic>
          <p className="relative mt-8 text-sm text-night-muted">
            Not out yet? Leave your email and we&rsquo;ll tell you.
          </p>
          <div className="relative mt-4 flex justify-center">
            <WaitlistForm source="home" tone="night" compact />
          </div>
        </Reveal>
      </Aurora>
    </section>
  );
}
