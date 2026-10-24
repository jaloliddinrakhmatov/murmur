# @murmur/web

The Murmur marketing site: Next.js 16 (App Router), Tailwind 4, no database. Pages are static except
the referral and invite landing pages, which ask the account server from the visitor's browser.

## Run

```bash
npm run dev -w apps/web        # http://localhost:3000
npm run build -w apps/web && npm start -w apps/web
npm test -w apps/web
```

Use `localhost:3000`, not `127.0.0.1:3000`: the server's CORS allows only `http://localhost:3000`.

**Without the server:** everything renders. Pricing comes from the shared catalog at build time. The
waitlist form, `/r/CODE` and `/join/TOKEN` show a friendly "server didn't answer" message.

**With the server** (see `apps/server/README.md`):

```bash
npm run db:start -w apps/server
MURMUR_DEV_OUTBOX=1 npm run dev -w apps/server   # http://127.0.0.1:4000/v1
```

## Environment

| Variable                 | Meaning                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_MURMUR_API` | Account server base URL including `/v1`. Inlined at build time. Default in development: `http://127.0.0.1:4000/v1`. In a production build it has no default (the forms report "not connected") so a live site never calls the visitor's own localhost. |

The server's `MURMUR_PUBLIC_URL` must equal this site's origin (it is the CORS origin).

## Structure

- `src/app/*`: pages. `r/[code]` and `join/[token]` validate the shape first (referral code with the contract's `ReferralCodeSchema`) and are `noindex` with `no-referrer`.
- `src/components/*`: sections, pricing view (monthly/annual toggle), waitlist form, landing states, legal layout.
- `src/content/*`: copy as data (home, pricing FAQ, privacy, terms).
- `src/lib/*`: pure logic with tests in `test/` (pricing maths, comparison table, email checks, API client and error mapping).
- Responses are validated with `@murmur/account-api` (a workspace dependency, transpiled by Next).

## Decisions made

- Referral and invite pages fetch **client-side**: the server rate limit is per IP (30 per 15 minutes, shared by codes and invites), so a server-side fetch would make every visitor share the web host's IP; the pages stay static; link previews and crawlers never use up a code lookup; invite tokens stay out of the web host's logs.
- The invite page can copy the code but never prints it. The app flow it describes is the real one: sign in with the invited address, then Settings, Team, Join a team, paste the code.
- Download requirements come from the packaging config: arm64 only; Electron's minimum is macOS 13; system audio capture needs 14.2+.

## Placeholders and to do

- **Prices, features and the sales address** come from `packages/account-api/src/plans.ts` and are placeholders ("Prices are not final" is shown on the page).
- **Privacy and Terms** are drafts, not reviewed by a lawyer; `[Company name]`, `[Contact email]`, `[Hosting provider]`, etc. are to be filled in.
- **Sitemap and canonical URLs/OG images:** need a domain. `robots.txt` exists (no sitemap line). TODO: add `metadataBase`, `sitemap.ts` and share images once the domain is known.
- Waitlist: nobody is emailed yet; the server design note about an unsubscribe link must be built before any mailing.

## Questions for you

- Real prices, plan contents and whether paid plans include transcription or stay bring-your-own-key.
- Company name, address, contact email, governing law, minimum age, response time and liability cap for the legal pages.
- The domain and where to host the site and server.
