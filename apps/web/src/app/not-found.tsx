import type { Metadata } from "next";
import Link from "next/link";
import { NotFoundArt } from "../components/not-found-art.tsx";
import { Reveal } from "../motion/reveal.tsx";
import { SplitHeading } from "../motion/split-heading.tsx";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <section className="container-m py-28 text-center">
      <NotFoundArt />
      <p className="eyebrow">404</p>
      <SplitHeading as="h1" eager className="display mt-4 text-5xl sm:text-6xl">
        That page <em>wandered off</em>
      </SplitHeading>
      <Reveal eager delay={0.3}>
        <p className="mx-auto mt-5 max-w-md text-lg text-muted">
          The link may be old or mistyped. Nothing was said here.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/" className="btn btn-primary">
            Back to home
          </Link>
          <Link href="/pricing" className="btn btn-ghost">
            See pricing
          </Link>
        </div>
      </Reveal>
    </section>
  );
}
