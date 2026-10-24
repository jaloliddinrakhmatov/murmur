// An in-memory Murmur server that speaks the shared contract (@murmur/account-api), for tests
// and for the capture's throwaway screens. It never opens a socket: `fetch` answers directly.
// Not part of the app's start-up path.
import { API_PREFIX, RULES } from "@murmur/account-api";

type Json = Record<string, unknown>;

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatar: string | null;
  createdAt: string;
  referralCode: string;
  teamId: string | null;
  appliedCode: { code: string; at: string } | null;
}

interface FakeTeam {
  id: string;
  name: string;
  members: {
    userId: string;
    role: "owner" | "admin" | "member";
    joinedAt: string;
  }[];
  invites: {
    id: string;
    email: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }[];
  token: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: Json | null;
  authorized: boolean;
}

const PLANS = [
  {
    id: "free",
    name: "Free",
    audience: "For trying Murmur",
    price: 0,
    features: ["Dictation anywhere on your Mac", "Dictionary and snippets"],
  },
  {
    id: "pro",
    name: "Pro",
    audience: "For everyday writing",
    price: 1500,
    features: ["Everything in Free", "AI cleanup and Transforms", "Notetaker"],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    audience: "For organisations",
    price: null,
    features: ["Everything in Pro", "Single sign-on", "Priority support"],
  },
] as const;

export class FakeMurmurServer {
  readonly requests: RecordedRequest[] = [];
  /** Words reported per day (the largest wins, like the real server). */
  readonly usage = new Map<string, number>();
  offline = false;
  testMode = true;
  signInCode = "123456";
  /** What /auth/start reports as `delivery` (undefined: an older server that says nothing). */
  delivery: "email" | "outbox" | undefined = undefined;
  now: () => number = Date.now;
  accessTtlMs = 15 * 60_000;
  private readonly users = new Map<string, User>();
  private readonly teams = new Map<string, FakeTeam>();
  private readonly access = new Map<
    string,
    { userId: string; expires: number }
  >();
  private readonly refresh = new Map<string, string>();
  private readonly subscriptions = new Map<string, Json>();
  private readonly referrals: Json[] = [];
  private counter = 0;
  private creditMonths = 0;
  private promo: Json | null = null;

  private id(prefix: string): string {
    return `${prefix}_${++this.counter}`;
  }

  /** Forgets everything (the capture starts each theme from a signed-out, empty server). */
  reset(): void {
    this.users.clear();
    this.teams.clear();
    this.access.clear();
    this.refresh.clear();
    this.subscriptions.clear();
    this.referrals.length = 0;
    this.requests.length = 0;
    this.usage.clear();
    this.creditMonths = 0;
    this.promo = null;
    this.offline = false;
  }

  /** Adds a teammate to the first team (sample data for the capture). */
  addMember(
    email: string,
    name: string,
    role: "admin" | "member" = "member",
  ): void {
    const team = [...this.teams.values()][0];
    if (!team) return;
    const user = this.createUser(email);
    const [first = "", ...rest] = name.split(" ");
    user.firstName = first;
    user.lastName = rest.join(" ");
    user.teamId = team.id;
    this.users.set(user.id, user);
    team.members.push({
      userId: user.id,
      role,
      joinedAt: new Date(this.now()).toISOString(),
    });
  }

  /** Makes every access token fail with 401 (the client must refresh once). */
  expireAccessTokens(): void {
    this.access.clear();
  }

  /** Revokes every refresh token (the saved sign-in is no longer valid). */
  revokeRefreshTokens(): void {
    this.refresh.clear();
  }

  addReferral(
    label: string,
    status: "signed-up" | "qualified" | "rewarded",
    words: number,
  ): void {
    this.referrals.push({
      id: this.id("ref"),
      label,
      status,
      words,
      createdAt: new Date(this.now()).toISOString(),
      rewardedAt:
        status === "rewarded" ? new Date(this.now()).toISOString() : null,
    });
    if (status === "rewarded") this.creditMonths += 1;
  }

  /** The invite code of the only team (for the "join with a code" flow). */
  inviteToken(): string | null {
    return [...this.teams.values()][0]?.token ?? null;
  }

  private res(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  private err(status: number, code: string, message = code): Response {
    return this.res(status, { code, message });
  }

  private meOf(u: User): Json {
    const team = u.teamId ? this.teams.get(u.teamId) : null;
    const role = team?.members.find((m) => m.userId === u.id)?.role;
    return {
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      avatar: u.avatar,
      createdAt: u.createdAt,
      plan: this.planOf(u),
      referralCode: u.referralCode,
      team: team && role ? { id: team.id, name: team.name, role } : null,
    };
  }

  private planOf(u: User): Json {
    const sub = this.subscriptions.get(u.id);
    if (sub)
      return {
        tier: sub.plan,
        source: "subscription",
        until: sub.currentPeriodEnd,
      };
    if (u.teamId)
      return {
        tier: "pro",
        source: "trial",
        until: new Date(
          this.now() + RULES.teamTrialDays * 86_400_000,
        ).toISOString(),
      };
    if (this.creditMonths > 0)
      return {
        tier: "pro",
        source: "referral",
        until: new Date(this.now() + 30 * 86_400_000).toISOString(),
      };
    return { tier: "free", source: "none", until: null };
  }

  private teamOf(team: FakeTeam, viewer: User): Json {
    const mine = team.members.find((m) => m.userId === viewer.id)!;
    return {
      id: team.id,
      name: team.name,
      role: mine.role,
      trialEndsAt: new Date(
        this.now() + RULES.teamTrialDays * 86_400_000,
      ).toISOString(),
      members: team.members.map((m) => {
        const u = [...this.users.values()].find((x) => x.id === m.userId)!;
        return {
          userId: m.userId,
          email: u.email,
          name: `${u.firstName} ${u.lastName}`.trim(),
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
      invites: mine.role === "member" ? [] : team.invites,
    };
  }

  private billingOf(u: User): Json {
    return {
      plan: this.planOf(u),
      subscription: this.subscriptions.get(u.id) ?? null,
      creditMonths: this.creditMonths,
      promo: this.promo,
      testMode: this.testMode,
    };
  }

  private tokensFor(u: User): Json {
    const accessToken = this.id("acc");
    const refreshToken = this.id("rtok");
    const expires = this.now() + this.accessTtlMs;
    this.access.set(accessToken, { userId: u.id, expires });
    this.refresh.set(refreshToken, u.id);
    return {
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(expires).toISOString(),
    };
  }

  private invite(team: FakeTeam, emails: string[]): void {
    for (const email of emails)
      team.invites.push({
        id: this.id("inv"),
        email,
        status: "pending",
        createdAt: new Date(this.now()).toISOString(),
        expiresAt: new Date(
          this.now() + RULES.teamInviteDays * 86_400_000,
        ).toISOString(),
      });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.offline) throw new TypeError("fetch failed");
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.startsWith(API_PREFIX)
      ? url.pathname.slice(API_PREFIX.length)
      : url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
    const headers = new Headers(init?.headers);
    const bearer =
      headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    this.requests.push({ method, path, body, authorized: Boolean(bearer) });

    if (method === "GET" && path === "/dev/outbox")
      return this.res(200, {
        emails: [{ kind: "sign-in-code", code: this.signInCode }],
      });
    if (method === "POST" && path === "/auth/start")
      return this.res(200, {
        ok: true,
        expiresInSec: 600,
        ...(this.delivery ? { delivery: this.delivery } : {}),
      });
    if (method === "POST" && path === "/auth/verify") {
      if (body?.code !== this.signInCode)
        return this.err(400, "code-invalid", "Wrong code");
      const email = String(body.email);
      let u = [...this.users.values()].find((x) => x.email === email);
      u ??= this.createUser(email);
      this.users.set(u.id, u);
      return this.res(200, { tokens: this.tokensFor(u), me: this.meOf(u) });
    }
    if (method === "POST" && path === "/auth/refresh") {
      const userId = this.refresh.get(String(body?.refreshToken));
      if (!userId) return this.err(401, "unauthorized");
      this.refresh.delete(String(body?.refreshToken));
      return this.res(200, { tokens: this.tokensFor(this.users.get(userId)!) });
    }

    const session = bearer ? this.access.get(bearer) : undefined;
    if (!session || session.expires <= this.now())
      return this.err(401, "unauthorized");
    const u = this.users.get(session.userId)!;
    const team = u.teamId ? (this.teams.get(u.teamId) ?? null) : null;
    const mine = team?.members.find((m) => m.userId === u.id);
    const manager = mine?.role === "owner" || mine?.role === "admin";

    if (method === "POST" && path === "/auth/signout") {
      this.refresh.delete(String(body?.refreshToken));
      this.access.delete(bearer!);
      return this.res(200, { ok: true });
    }
    if (path === "/me" && method === "GET") return this.res(200, this.meOf(u));
    if (path === "/me" && method === "PATCH") {
      if (typeof body?.firstName === "string") u.firstName = body.firstName;
      if (typeof body?.lastName === "string") u.lastName = body.lastName;
      return this.res(200, this.meOf(u));
    }
    if (path === "/me" && method === "DELETE") {
      if (body?.confirmEmail !== u.email)
        return this.err(400, "bad-request", "Email doesn't match");
      this.users.delete(u.id);
      this.refresh.clear();
      this.access.clear();
      return this.res(200, { ok: true });
    }
    if (path === "/me/avatar") {
      u.avatar = method === "PUT" ? String(body?.dataUrl) : null;
      return this.res(200, this.meOf(u));
    }
    if (path === "/teams/current" && method === "GET")
      return this.res(200, { team: team ? this.teamOf(team, u) : null });
    if (path === "/teams" && method === "POST") {
      if (team) return this.err(409, "team-exists");
      const t: FakeTeam = {
        id: this.id("team"),
        name: String(body?.name),
        members: [
          {
            userId: u.id,
            role: "owner",
            joinedAt: new Date(this.now()).toISOString(),
          },
        ],
        invites: [],
        token: `JOIN-${this.counter}-CODE`,
      };
      this.invite(t, (body?.invites as string[]) ?? []);
      this.teams.set(t.id, t);
      u.teamId = t.id;
      return this.res(200, this.teamOf(t, u));
    }
    if (path === "/teams/join" && method === "POST") {
      if (team) return this.err(409, "team-exists");
      const t = [...this.teams.values()].find((x) => x.token === body?.token);
      if (!t) return this.err(400, "code-invalid", "No such invite");
      t.members.push({
        userId: u.id,
        role: "member",
        joinedAt: new Date(this.now()).toISOString(),
      });
      u.teamId = t.id;
      return this.res(200, this.teamOf(t, u));
    }
    if (path.startsWith("/teams/current")) {
      if (!team || !mine) return this.err(404, "not-found");
      if (path === "/teams/current/leave" && method === "POST") {
        if (mine.role === "owner") return this.err(409, "team-last-owner");
        team.members = team.members.filter((m) => m !== mine);
        u.teamId = null;
        return this.res(200, { team: null });
      }
      if (!manager) return this.err(403, "forbidden");
      if (path === "/teams/current" && method === "PATCH") {
        team.name = String(body?.name);
        return this.res(200, this.teamOf(team, u));
      }
      if (path === "/teams/current/invites" && method === "POST") {
        this.invite(team, body?.emails as string[]);
        return this.res(200, this.teamOf(team, u));
      }
      const inv = /^\/teams\/current\/invites\/(.+)$/.exec(path);
      if (inv && method === "DELETE") {
        team.invites = team.invites.map((i) =>
          i.id === inv[1] ? { ...i, status: "revoked" } : i,
        );
        return this.res(200, this.teamOf(team, u));
      }
      const mem = /^\/teams\/current\/members\/(.+)$/.exec(path);
      if (mem && method === "PATCH") {
        const m = team.members.find((x) => x.userId === mem[1]);
        if (!m) return this.err(404, "not-found");
        if (m.role === "owner") return this.err(409, "team-last-owner");
        m.role = body?.role as "admin" | "member";
        return this.res(200, this.teamOf(team, u));
      }
      if (mem && method === "DELETE") {
        const m = team.members.find((x) => x.userId === mem[1]);
        if (m?.role === "owner") return this.err(409, "team-last-owner");
        team.members = team.members.filter((x) => x.userId !== mem[1]);
        return this.res(200, this.teamOf(team, u));
      }
    }
    if (path === "/referrals" && method === "GET")
      return this.res(200, {
        code: u.referralCode,
        link: `https://murmur.example/r/${u.referralCode}`,
        referrals: this.referrals,
        applied: u.appliedCode,
        creditMonths: this.creditMonths,
      });
    if (path === "/referrals/invite")
      return this.res(200, { sent: (body?.emails as string[]).length });
    if (path === "/referrals/apply") {
      if (body?.code === u.referralCode)
        return this.err(400, "referral-own-code");
      if (u.appliedCode) return this.err(409, "referral-already-applied");
      if (body?.code === "TOOLATE1") return this.err(400, "referral-too-late");
      if (body?.code !== "FRIEND12")
        return this.err(404, "not-found", "No such code");
      u.appliedCode = {
        code: String(body.code),
        at: new Date(this.now()).toISOString(),
      };
      this.creditMonths += RULES.referralRewardMonths;
      return this.res(200, { me: this.meOf(u) });
    }
    if (path === "/usage" && method === "POST") {
      const day = String(body?.day);
      this.usage.set(
        day,
        Math.max(this.usage.get(day) ?? 0, Number(body?.words)),
      );
      return this.res(200, { ok: true });
    }
    if (path === "/billing/plans") {
      const interval =
        url.searchParams.get("interval") === "annual" ? "annual" : "monthly";
      const discountPct = interval === "annual" ? 20 : 0;
      return this.res(200, {
        interval,
        currency: "usd",
        plans: PLANS.map((p) => ({
          id: p.id,
          name: p.name,
          audience: p.audience,
          priceCents:
            p.price === null
              ? null
              : Math.round(
                  (p.price * (100 - (p.id === "pro" ? discountPct : 0))) / 100,
                ),
          priceIsFrom: p.id === "enterprise",
          discountPct: p.id === "pro" ? discountPct : 0,
          features: [...p.features],
        })),
      });
    }
    if (path === "/billing" && method === "GET")
      return this.res(200, this.billingOf(u));
    if (path === "/billing/checkout" && method === "POST") {
      if (body?.plan === "enterprise")
        return this.res(200, {
          kind: "contact",
          email: "sales@murmur.example",
        });
      this.subscriptions.set(u.id, {
        plan: body?.plan,
        interval: body?.interval,
        seats: body?.seats,
        status: "active",
        currentPeriodEnd: new Date(this.now() + 30 * 86_400_000).toISOString(),
        cancelAtPeriodEnd: false,
      });
      return this.res(200, { kind: "activated", billing: this.billingOf(u) });
    }
    if (path === "/billing/cancel" && method === "POST") {
      const sub = this.subscriptions.get(u.id);
      if (!sub) return this.err(404, "not-found");
      sub.cancelAtPeriodEnd = true;
      return this.res(200, this.billingOf(u));
    }
    if (path === "/billing/promo" && method === "POST") {
      if (body?.code !== "WELCOME") return this.err(400, "promo-invalid");
      this.promo = { code: "WELCOME", description: "One extra month of Pro" };
      this.creditMonths += 1;
      return this.res(200, this.billingOf(u));
    }
    return this.err(404, "not-found");
  };

  private createUser(email: string): User {
    const id = this.id("user");
    return {
      id,
      email,
      firstName: "",
      lastName: "",
      avatar: null,
      createdAt: new Date(this.now()).toISOString(),
      referralCode: `MURMUR${this.counter}`.toUpperCase(),
      teamId: null,
      appliedCode: null,
    };
  }
}
