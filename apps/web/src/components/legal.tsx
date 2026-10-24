import type { LegalDoc } from "../content/legal-types.ts";
import { Reveal } from "../motion/reveal.tsx";
import { SplitHeading } from "../motion/split-heading.tsx";

export function LegalDocument({ doc }: { doc: LegalDoc }) {
  return (
    <div className="container-m max-w-3xl py-16 sm:py-24">
      <Reveal eager>
        <p className="eyebrow">{doc.eyebrow}</p>
      </Reveal>
      <SplitHeading as="h1" eager className="display mt-3 text-5xl sm:text-6xl">
        {doc.title}
      </SplitHeading>
      <Reveal eager delay={0.3}>
        <p className="mt-4 text-muted">Last updated {doc.updated}</p>
      </Reveal>
      <Reveal delay={0.1}>
        <div
          role="note"
          className="mt-8 rounded-2xl bg-accent-faint p-5 ring-1 ring-accent/40"
        >
          <p className="font-semibold">Draft: not yet reviewed by a lawyer</p>
          <p className="mt-1 text-[0.9375rem] leading-relaxed text-muted">
            This text describes what Murmur actually does today. Names in
            [square brackets] are placeholders to be filled in before launch.
          </p>
        </div>
      </Reveal>
      <Reveal>
        <nav aria-label="Contents" className="card mt-10 p-6">
          <h2 className="text-sm font-semibold">Contents</h2>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[0.9375rem]">
            {doc.sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="underline underline-offset-4">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      </Reveal>
      {doc.sections.map((s) => (
        <Reveal as="section" key={s.id} className="mt-12">
          <div id={s.id}>
            <h2 className="font-serif text-3xl">{s.title}</h2>
            {s.blocks.map((b, i) =>
              "p" in b ? (
                <p key={i} className="mt-4 leading-relaxed text-muted">
                  {b.p}
                </p>
              ) : (
                <ul
                  key={i}
                  className="mt-4 list-disc space-y-2 pl-6 leading-relaxed text-muted"
                >
                  {b.ul.map((li) => (
                    <li key={li}>{li}</li>
                  ))}
                </ul>
              ),
            )}
          </div>
        </Reveal>
      ))}
    </div>
  );
}
