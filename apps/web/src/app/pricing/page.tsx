import type { Metadata } from "next";
import { PLAN_CATALOG, plansFor } from "@murmur/account-api";
import { PricingView } from "../../components/pricing-view.tsx";
import { PRICING_FAQ } from "../../content/pricing.ts";
import { Icon } from "../../components/icons.tsx";
import { Reveal } from "../../motion/reveal.tsx";
import { SplitHeading } from "../../motion/split-heading.tsx";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Free, Pro and Enterprise plans for Murmur. Prices are placeholders and not final.",
};

export default function Page() {
  const data = { monthly: plansFor("monthly"), annual: plansFor("annual") };
  return (
    <div className="container-m py-16 sm:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <Reveal eager>
          <p className="eyebrow">Pricing</p>
        </Reveal>
        <SplitHeading
          as="h1"
          eager
          className="display mt-3 text-5xl sm:text-6xl"
        >
          Simple plans, <em>no surprises</em>
        </SplitHeading>
        <Reveal eager delay={0.35}>
          <p className="mt-5 text-lg leading-relaxed text-muted">
            Start free. Move up when you or your team want more.
          </p>
        </Reveal>
      </div>
      <PricingView data={data} salesEmail={PLAN_CATALOG.salesEmail} />
      <section aria-labelledby="pfaq" className="mx-auto mt-24 max-w-3xl">
        <SplitHeading id="pfaq" className="display text-center text-4xl">
          Pricing <em>questions</em>
        </SplitHeading>
        <Reveal className="mt-10">
          <div className="divide-y divide-hairline rounded-3xl bg-sheet px-6 shadow-card ring-1 ring-hairline sm:px-8">
            {PRICING_FAQ.map((item) => (
              <details key={item.q} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <Icon
                    name="chevron"
                    size={20}
                    className="shrink-0 text-muted transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
          </div>
        </Reveal>
      </section>
    </div>
  );
}
