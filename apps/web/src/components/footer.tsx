import Link from "next/link";
import { FOOTER, SITE } from "../content/site.ts";
import { Logo } from "./logo.tsx";

export function Footer() {
  return (
    <footer className="border-t border-hairline bg-surface/60">
      <div className="container-m grid gap-12 py-14 md:grid-cols-[1.4fr_2fr]">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-[0.9375rem] leading-relaxed text-muted">
            {SITE.tagline}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {FOOTER.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <h2 className="text-sm font-semibold">{group.title}</h2>
              <ul className="mt-4 space-y-3">
                {group.links.map((link) => (
                  <li key={link.href + link.label}>
                    <Link
                      href={link.href}
                      className="inline-block text-[0.9375rem] text-muted transition-[color,transform] duration-300 hover:translate-x-1 hover:text-fg"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
      <div className="container-m border-t border-hairline py-6 text-sm text-muted">
        © {new Date().getFullYear()} Murmur. All rights reserved.
      </div>
    </footer>
  );
}
