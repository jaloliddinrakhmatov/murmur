# @murmur/server

The Murmur account server for Stage B: accounts (email sign-in codes), teams and invites,
referrals, daily usage and plans/billing. NestJS 12 + Prisma 7 + PostgreSQL 17, validated with the
shared contract in `packages/account-api` (that package is the source of truth for routes, schemas,
error codes and `RULES`).

The server never receives dictations, audio, notes or transcripts: only account data and a daily
word count.

**Status: runs locally only.** No hosting, no real email, no real payments. See "Needs approval".

## Run it locally

Needs PostgreSQL 17 from Homebrew (`/opt/homebrew/opt/postgresql@17`; override with `PG_BIN`).
All commands run from the repo root.

```sh
npm run db:start -w apps/server     # first run: initdb into apps/server/.dev/pgdata; port 54329,
                                    # databases murmur_dev and murmur_test
npm run db:migrate -w apps/server   # prisma migrate dev (applies migrations to murmur_dev)
MURMUR_DEV_OUTBOX=1 npm run dev -w apps/server   # http://127.0.0.1:4000/v1 (loopback only)
npm run db:stop -w apps/server
```

The cluster is project-local (not a system service), trusts local connections only and listens on
127.0.0.1. Nothing is stored outside `apps/server/.dev/` (git-ignored, like `.env`).

Configuration is by environment variables (see `.env.example`). **Production is the default:** only
`MURMUR_ENV=development` (set by `npm run dev`) or `MURMUR_ENV=test` (the test harness) allow the
dev secrets, the test payment provider and the dev outbox. Any other or missing value means
production, which refuses to start without real secrets, `DATABASE_URL`, an `https://`
`MURMUR_PUBLIC_URL`, an email provider and a payment provider. `npm start` therefore refuses to
start until those exist.

| Variable                               | Meaning                                                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                         | Default `postgresql://murmur@127.0.0.1:54329/murmur_dev`                                                                                                                                                                                        |
| `PORT`                                 | Default 4000. The host is always `127.0.0.1`.                                                                                                                                                                                                   |
| `MURMUR_ENV`                           | `development` or `test` enable local defaults; anything else (or unset) is production                                                                                                                                                           |
| `MURMUR_PEPPER`, `MURMUR_TOKEN_SECRET` | Keys for hashing secrets / signing access tokens. Required (32+ chars, different) in production.                                                                                                                                                |
| `MURMUR_DEV_OUTBOX=1`                  | Exposes `GET /v1/dev/outbox` (only with `MURMUR_ENV=development` or `test`)                                                                                                                                                                     |
| `MURMUR_PUBLIC_URL`                    | Public base URL; required in production (https) and the only `Host` accepted there. Also the CORS origin for `/v1/public/*` and the base of invite/referral links. Development default: `http://localhost:3000` (the local website, `apps/web`) |

To sign in during development: `POST /v1/auth/start`, then read the code with
`GET /v1/dev/outbox?to=you@example.com` (needs `MURMUR_DEV_OUTBOX=1`), then `POST /v1/auth/verify`.
Invite codes and referral emails appear in the same outbox.

## Tests

```sh
npm test -w apps/server      # or `npm test` at the repo root
```

`scripts/test.ts` runs the unit tests (`test/unit`, pure logic: plan-state resolution, renewal,
referral reward, rate limiter, crypto), then starts the local cluster if it isn't running,
migrates `murmur_test`, and runs the end-to-end tests (`test/e2e`, every route through real HTTP
against `murmur_test`, signing in through the real code flow). If Postgres can't be started the
e2e tests are skipped with a message and the command still succeeds. If the runner started the
cluster it stops it again. Tests need no network.

Why Node's test runner with `tsx` (not Jest/Vitest): the repo already uses `node --test`. Nest's
decorators are not erasable TypeScript, so the server runs through `tsx` (esbuild), which supports
`experimentalDecorators`; it does not emit decorator metadata, so every constructor parameter uses
an explicit `@Inject(...)`. Type checking is `tsc` (`npm run typecheck`).

## Design notes

- **Access tokens** are HMAC-signed, expire after 15 minutes and carry the user and device. Each
  request also checks the device row, so sign-out, token-reuse detection and account deletion
  take effect immediately and there is no token table to grow. **Refresh tokens** are random,
  stored only as peppered SHA-256 (HMAC) hashes, valid 60 days, and rotate on every use. A rotated
  token presented again within a 60-second grace window (`refreshGraceMs`; the response was lost, or
  two requests raced) returns the same successor, which is kept AES-256-GCM encrypted (key derived
  from `MURMUR_TOKEN_SECRET`, bound to the row) only for that window. Presenting a rotated token
  later, or after its successor was used, revokes the whole device session. Trade-off: a thief who
  replays a stolen token within the first minute gets the successor too.
- **Host check**: every request's `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the port
  the server listens on (development), or exactly the `MURMUR_PUBLIC_URL` host (production), so a
  DNS-rebinding page can't talk to the local server. Otherwise 403.
- **Sign-in caps**: besides the per-IP/per-email bursts in memory, each normalized address (see
  below) gets at most 10 sign-in codes and 50 verify attempts per 24 hours, stored in Postgres
  (`AuthAttempt`, keyed by a peppered hash) so restarts don't reset them. After 3 codes (10 verify
  attempts) each next attempt must wait 30 s (5 s) doubling up to 1 h (15 min). Blocked attempts
  are not recorded. Limits and backoff live in `src/config/env.ts`. A person who can guess your
  address can use up its daily budget (inherent to per-address caps).
- **Sign-in codes**: 6 digits, hashed (bound to the email), valid 10 minutes, 5 tries counted
  atomically, a new code replaces the old one. `/auth/start` answers identically whether or not the
  account exists.
- **Plan state** (`src/domain/plan-state.ts`, pure): active subscription > team trial > referral
  credit > free. Team members also get the plan their team owner pays for, but only the first
  `seats` members (owner first, then by join date) do. The 14-day trial covers everyone. While a
  paid team plan is active, inviting (members + pending invites) or joining beyond `seats` fails
  with `409 seats-full` (new `ErrorBody` code). Referral credit is consumed month by month from the moment it is first
  needed; while a trial or subscription is active it waits, and at a renewal it extends the paid
  period instead (`src/domain/renewal.ts`, pure). Time-dependent state is brought up to date
  lazily on read (`PlanService.sync`); there is no scheduler.
- **Referrals**: the friend gets `RULES.referralRewardMonths` immediately on apply; the referrer
  gets one credit month, exactly once, when all of these hold (`REFERRAL_ANTI_FARMING` in
  `src/config/env.ts` plus `RULES.referralRewardWords`): the friend's total reported words reach
  the threshold, on at least 3 distinct days, the friend's account is at least 3 days old, the
  friend's address was never paid for before, and the referrer has been paid fewer than 12 times
  in the last 365 days. Until then the status stays `signed-up` (it may stay so longer than the
  words suggest; progress is capped at the threshold). The status `qualified` exists in the
  contract but is never used. Applying a code is refused for your own code (also through an alias
  of your address), a second time, and when the code's owner joined with your code (mutual).
- **Anti-farming tombstones** (`EmailTombstone`, no foreign key, survives account deletion): one
  row per normalized address hash (lower-case, `+tag` removed, dots removed and `googlemail.com`
  treated as `gmail.com` for Gmail; peppered HMAC, never the address) recording that the address
  was referred, claimed the team trial, or had a referral reward paid. Each is claimed with an
  atomic conditional update. Deleting an account also records what the account had used, for
  accounts created before the table existed.
- **One trial per person**: the team trial is granted the first time a person (normalized address) creates a team, even after deleting the account.
- **Rate limits** (in memory, one process, plus the persisted daily caps above; `src/config/env.ts`): sign-in codes 5 per 15 min per
  email and 20 per IP, verify attempts per IP and email, joining a team 10 per 15 min, and
  invitation emails (team + referral) 50 per day per user. Swap `RateLimiter` for a shared store
  (Redis) before running more than one instance.
- **HTTP statuses**: 200 for everything except `POST /teams` (201). Errors are always the
  contract's `ErrorBody`: bad-request 400 (413 for an oversize body), unauthorized 401, forbidden
  403, not-found 404, conflict 409, rate-limited 429, code-invalid/code-expired 400,
  referral-own-code 400, referral-too-late 409, referral-already-applied 409, team-exists 409,
  team-last-owner 409, seats-full 409, promo-invalid 400, server-error 500.
- **Plan catalog** is `PLAN_CATALOG` in `packages/account-api/src/plans.ts` (shared with the website; `plansFor(interval)` builds the `PlansResponse`), promo codes are in `src/config/plans.ts`; all placeholders (Pro 1000 cents per
  user per month, annual 20% off, Enterprise "contact us", test promo `WELCOME10`). Edit freely.
- **Emails**: subjects are fixed text (no user input). Names in bodies are stripped of control
  characters, collapsed and cut to 40 characters; the contract also rejects control/format
  characters (`\p{Cc}`, `\p{Cf}`) in names. Emails lead with the code and say where to paste it in
  Murmur (Settings > Team > Join; Get a free month > Apply referral). The `link` fields
  (`{MURMUR_PUBLIC_URL}/r/CODE`, `/join/TOKEN`) are pages of the website (`apps/web`; in
  development `http://localhost:3000`). Emails still lead with the code and don't include them.
- **Public website routes** (`/v1/public/*`, no sign-in, Host-checked, CORS only for the website
  origin, rate-limited per IP; `req.ip`, so behind a proxy `trust proxy` must be set first):
  `GET plans?interval=`, `GET referral/:code` (`{valid, firstName?}`: first name only, if set,
  never last name or email; code lookups and invite lookups share 30 per 15 min per IP so codes
  can't be enumerated), `GET invite/:token` (`{valid, teamName?, expired?}`, never the invitee) and
  `POST waitlist {email, source?}` (`{ok:true}` always, repeats and `+tag` variants are silent
  no-ops, 10 per IP per day). The waitlist stores the address as typed (needed to write to the
  person) plus a peppered hash of the normalized one (`WaitlistEntry`). Nobody is emailed.
- **Unsubscribe/delete (design note, not built)**: every future waitlist email carries a link
  `{publicUrl}/waitlist/leave?token=…` where the token is an HMAC of the entry id (pepper-keyed,
  no table needed); the page calls a `POST /v1/public/waitlist/leave` that deletes the row.
  Needed before any email is sent, and for GDPR-style deletion requests.
- **Logging** never includes codes, tokens or full addresses (addresses are masked as `j***@host`).
  Unhandled errors log only the error's name.

## Website help chat

The marketing site (`apps/web`) has an AI help widget. The server side is stateless and public:

- `GET /v1/public/help/status` answers `{available}`: false when no provider is configured or today's budget is used up.
- `POST /v1/public/help/chat` takes `HelpChatRequest` (`packages/account-api`) and answers
  `text/event-stream`: `data: {json}` lines, any number of `delta`, then exactly one `done` or `error`.
  Problems found before streaming starts are ordinary `ErrorBody` responses: 400 (invalid request),
  429 `rate-limited` (per-IP limits), 503 `help-unavailable` (not configured, or the daily budget).
  Headers are flushed at once (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`).

Same rules as the other public routes: Host-checked, CORS for the website origin only (the preflight allows
`POST` with `Content-Type` and `Accept`), per-IP `req.ip`.

**Set up (local or production):** `npm run help:setup -w apps/server` asks for the service (`groq`, `gemini` or
`openai`), a model (optional) and the key (hidden input), and writes only the `MURMUR_HELP_*` lines of
`apps/server/.env` (mode 0600). `npm run help:test -w apps/server` sends one question and prints whether it
streamed, the first 200 characters and the latency (spends a tiny amount). `npm run help:eval -w apps/server`
runs 22 questions (Uzbek, Russian, an off-topic task, a prompt-injection attempt, a pasted key, prices and
release dates) with keyword checks; it spends credits, so run it when you change the guide, the prompt or the
model. With `MURMUR_HELP_PROVIDER=fake` it only exercises the script.

| Variable                  | Meaning                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MURMUR_HELP_PROVIDER`    | `groq`, `gemini`, `openai`, or `fake` (development/test only; production refuses it). Unset = chat off. A typo or a missing key stops the server instead of silently disabling the chat. |
| `MURMUR_HELP_API_KEY`     | The provider's key. Only `.env` / the host's secrets, never code.                                                                                                                        |
| `MURMUR_HELP_MODEL`       | Optional. Defaults: groq `openai/gpt-oss-120b` (passed Murmur's AI quality eval), gemini `gemini-3.5-flash-lite`, openai `gpt-4o-mini`.                                                  |
| `MURMUR_HELP_DAILY_LIMIT` | Answers per rolling 24 hours, all visitors together. Default 500.                                                                                                                        |
| `MURMUR_HELP_CONTACT`     | Optional contact email. Replaces `[Contact email]` in the guide; until set, the assistant says contact details will be added soon.                                                       |

**How it works.** `src/help/knowledge.md` is the help guide (the only source of facts); `src/help/prompt.ts`
builds the system prompt (role, rules, guide; the page kind is a short note at the very end so the static part
can be cached by the provider). `src/help/openai-compatible.ts` streams chat completions with plain `fetch`
(no SDK; 30 s upstream timeout; at most 700 output tokens, plus 1024 reasoning room for GPT-OSS; Gemini's
thinking set to minimal), and `src/help/help.service.ts` applies the limits and maps failures to `error`
events (provider text is never read into a message). If the visitor disconnects, the upstream request is
cancelled. The guide is plain Markdown: update it when the app changes, and run `help:eval`.

**Privacy.** Questions and answers are not stored. The log has only `outcome`, message count, answer length and
latency (and "refused" lines with the limit that applied). The provider does receive the conversation to answer
it: say so in the privacy policy. Nothing identifying (no IP, no path, no referral code) is sent to it; the
browser sends the page _kind_, not the path.

**Cost controls.** 12 questions per 10 minutes and 60 per day per IP (`helpPerIpShort`, `helpPerIpDaily` in
`src/config/env.ts`), the global daily cap, 700-token answers, at most 16 messages of at most 1,500 characters,
and a provider failure that produced no answer does not use up any allowance. The counters are in memory (one
process; they reset on restart, like the other rate limits). Behind a proxy `trust proxy` must be set first or
every visitor shares one IP.

**Decisions for you:** which service and model to use and the monthly budget (worst-case spend is about
`MURMUR_HELP_DAILY_LIMIT` x 30 days x the cost of one answer: measure that with `help:test` and your
provider's usage page, then set the cap); a contact email for `MURMUR_HELP_CONTACT`; whether to add bot
protection (for example Cloudflare Turnstile) before the site is public, because per-IP limits do not stop a
botnet and the global cap would then be used up by bots; and the privacy-policy wording for the provider.

## Dev adapters and empty slots

| Slot     | Interface                           | Dev implementation                                                               | Real one                                     |
| -------- | ----------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| Email    | `Mailer` (`src/mail/mailer.ts`)     | `DevOutboxMailer`: stores mail in `OutboxEmail`, logs "email queued to j***@x"   | empty (SMTP / Resend / Postmark)             |
| Payments | `PaymentProvider` (`src/payments/`) | `TestPaymentProvider`: checkout activates the plan, nothing charged (`testMode`) | empty (Stripe: checkout redirect + webhooks) |

In production (anything but `MURMUR_ENV=development|test`) the server refuses to start without a real `Mailer` and
`PaymentProvider` passed to `AppModule.register`, so the dev adapters can never run there by
accident.

## Needs the user's approval before any of it happens

- Hosting (where this runs, TLS, backups, secrets management) and a public domain/URL (production links use the placeholder `https://murmur.example` until then).
- An email provider and sending domain (SPF/DKIM). Until then sign-in codes only reach the dev
  outbox.
- A payment provider, legal entity and tax setup. Until then billing is test mode only.
- Real prices, plan names and features (the catalog is placeholder).
- A privacy-policy/terms update before accounts ship (the server stores email, names, avatar,
  daily word counts and team membership).

## Decisions for the user

- **Waitlist emails**: sending to waitlist signups (even a "you're on the list" confirmation)
  needs a decision on double opt-in (confirm-by-link before anything else is sent), what the
  sender may say, and the unsubscribe path above. Until then nothing is sent. TODO.
