"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import {
  comparisonRows,
  priceDisplay,
  type Interval,
  type PlansData,
} from "../lib/pricing.ts";
import { NumberRoll } from "../motion/number-roll.tsx";
import { Reveal } from "../motion/reveal.tsx";
import { SplitHeading } from "../motion/split-heading.tsx";
import { Icon } from "./icons.tsx";

const INTERVALS: { id: Interval; label: string }[] = [
  { id: "monthly", label: "Monthly" },
  { id: "annual", label: "Annual" },
];

export function PricingView({
  data,
  salesEmail,
}: {
  data: Record<Interval, PlansData>;
  salesEmail: string;
}) {
  const [interval, setInterval] = useState<Interval>("monthly");
  const buttons = useRef<Partial<Record<Interval, HTMLButtonElement | null>>>(
    {},
  );
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);

  // The sliding pill follows the active button (measured, so it also survives font loading and resizes).
  useLayoutEffect(() => {
    const measure = () => {
      const b = buttons.current[interval];
      if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [interval]);
  const current = data[interval];
  const rows = comparisonRows(current.plans);
  const maxDiscount = Math.max(...data.annual.plans.map((p) => p.discountPct));

  return (
    <>
      <div className="mt-10 flex justify-center">
        <div
          role="group"
          aria-label="Billing interval"
          className="relative inline-flex rounded-full bg-surface-strong p-1"
        >
          {pill && (
            <span
              aria-hidden="true"
              className="absolute top-1 bottom-1 left-0 rounded-full bg-modal shadow-card transition-[transform,width] duration-500 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
              style={{ width: pill.w, transform: `translateX(${pill.x}px)` }}
            />
          )}
          {INTERVALS.map((i) => (
            <button
              key={i.id}
              ref={(el) => {
                buttons.current[i.id] = el;
              }}
              type="button"
              aria-pressed={interval === i.id}
              onClick={() => setInterval(i.id)}
              className={`relative z-10 min-h-10 rounded-full px-5 text-[0.9375rem] font-semibold transition-colors ${
                interval === i.id
                  ? `text-fg ${pill ? "" : "bg-modal shadow-card"}`
                  : "text-fg/80 hover:text-fg"
              }`}
            >
              {i.label}
              {i.id === "annual" && maxDiscount > 0 && (
                <span className="ml-2 text-xs font-bold text-fg">
                  Save {maxDiscount}%
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <p className="sr-only" role="status">
        Showing {interval} prices.
      </p>

      <Reveal
        as="ul"
        stagger={0.12}
        className="mt-10 grid gap-5 lg:grid-cols-3"
      >
        {current.plans.map((plan) => {
          const price = priceDisplay(plan, interval, current.currency);
          const featured = plan.id === "pro";
          const enterprise = plan.priceCents === null;
          return (
            <li
              key={plan.id}
              data-lift=""
              className={`card flex flex-col p-7 ${
                featured ? "ring-2 ring-accent" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <h2 className="font-serif text-3xl">{plan.name}</h2>
                {featured && (
                  <span className="rounded-full bg-accent-faint px-2.5 py-0.5 text-xs font-semibold text-accent-text">
                    Recommended
                  </span>
                )}
              </div>
              <p className="mt-1 text-muted">{plan.audience}</p>
              <p className="mt-6 flex items-baseline gap-2">
                {price.prefix && (
                  <span className="text-sm text-muted">{price.prefix}</span>
                )}
                <NumberRoll
                  value={price.amount}
                  className="font-serif text-5xl"
                />
                {price.unit && (
                  <span className="text-sm text-muted">{price.unit}</span>
                )}
              </p>
              <p className="mt-1 min-h-5 text-sm text-muted">
                {price.billedNote}
                {price.badge && (
                  <span className="ml-2 font-semibold text-accent-text">
                    {price.badge}
                  </span>
                )}
              </p>
              <ul className="mt-6 flex-1 space-y-3 border-t border-hairline pt-6">
                {plan.features.map((f) => (
                  <li key={f} className="flex gap-3">
                    <Icon
                      name="check"
                      size={20}
                      className="mt-0.5 shrink-0 text-accent-text"
                    />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              {enterprise ? (
                <a href={`mailto:${salesEmail}`} className="btn btn-ghost mt-8">
                  Contact us
                </a>
              ) : (
                <Link
                  href="/download"
                  className={`btn mt-8 ${featured ? "btn-primary" : "btn-ghost"}`}
                >
                  {plan.priceCents === 0 ? "Get Murmur free" : "Get started"}
                </Link>
              )}
            </li>
          );
        })}
      </Reveal>

      <p className="mx-auto mt-8 max-w-xl text-center text-sm text-muted">
        Prices are not final. Paid plans can&rsquo;t be bought yet; the download
        is coming first.
      </p>

      <section className="mt-20">
        <SplitHeading
          id="compare-title"
          className="display text-center text-4xl"
        >
          Compare <em>plans</em>
        </SplitHeading>
        <Reveal className="mt-10">
          <div
            tabIndex={0}
            role="region"
            aria-labelledby="compare-title"
            className="overflow-x-auto rounded-3xl bg-sheet shadow-card ring-1 ring-hairline"
          >
            <table className="w-full min-w-[34rem] border-collapse text-left">
              <caption className="sr-only">
                What each plan includes ({interval} prices)
              </caption>
              <thead>
                <tr className="border-b border-hairline">
                  <th scope="col" className="px-6 py-4 text-sm text-muted">
                    Feature
                  </th>
                  {current.plans.map((p) => (
                    <th
                      key={p.id}
                      scope="col"
                      className="px-4 py-4 font-semibold"
                    >
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-hairline">
                  <th scope="row" className="px-6 py-4 font-medium">
                    Price
                  </th>
                  {current.plans.map((p) => {
                    const d = priceDisplay(p, interval, current.currency);
                    return (
                      <td key={p.id} className="px-4 py-4">
                        {d.amount}
                        {d.unit && p.priceCents ? (
                          <span className="text-sm text-muted">
                            {" "}
                            / user / mo
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
                {rows.map((row) => (
                  <tr
                    key={row.feature}
                    className="border-b border-hairline last:border-0"
                  >
                    <th scope="row" className="px-6 py-4 font-medium">
                      {row.feature}
                    </th>
                    {row.included.map((yes, i) => (
                      <td key={current.plans[i].id} className="px-4 py-4">
                        {yes ? (
                          <>
                            <Icon
                              name="check"
                              size={20}
                              className="text-accent-text"
                            />
                            <span className="sr-only">Included</span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden="true" className="text-muted">
                              &mdash;
                            </span>
                            <span className="sr-only">Not included</span>
                          </>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </section>
    </>
  );
}
