// The Murmur account (Stage B): sign-in by emailed code, profile, team, referrals and plans, all
// through the contract in @murmur/account-api. The refresh token lives only in the macOS Keychain
// (through `TokenVault`); the access token lives in memory. Nothing runs or contacts a server until
// the person signs in (a saved sign-in is checked once, in the background, after the Keychain answers).
import type { z } from "zod";
import {
  API_PREFIX,
  ApplyReferralRequest,
  AuthStartRequest,
  AuthVerifyRequest,
  CheckoutRequest,
  CreateTeamRequest,
  DeleteMeRequest,
  ErrorBody,
  InviteRequest,
  JoinTeamRequest,
  PromoRequest,
  ReferralInviteRequest,
  ROUTES,
  SetAvatarRequest,
  SetRoleRequest,
  UpdateMeRequest,
  UpdateTeamRequest,
  type BillingInterval,
  type Me,
  type RouteName,
} from "@murmur/account-api";
import type {
  AccountStatus,
  AccountSwitchPrompt,
  LocalDataCounts,
} from "../../shared/account.ts";
import { checkServerUrl } from "../../shared/server-url.ts";
import {
  AccountError,
  OFFLINE_MESSAGE,
  codeForStatus,
  friendlyMessage,
} from "./errors.ts";

type Log = (event: string, data?: Record<string, unknown>) => void;

export interface TokenVault {
  available(): Promise<boolean>;
  load(): Promise<
    | { state: "absent" }
    | { state: "ok"; token: string; origin: string | null }
    | { state: "locked" | "unreadable" }
  >;
  /** The token is stored with the server address it was issued by. */
  save(token: string, origin: string): Promise<void>;
  clear(): void;
}

export interface AccountDeps {
  fetch: typeof fetch;
  serverUrl: () => string;
  packaged: boolean;
  vault: TokenVault;
  appVersion: string;
  /** Words delivered on a local calendar day (YYYY-MM-DD), from local History. A number only. */
  wordsOn: (day: string) => number;
  now?: () => number;
  notify: (status: AccountStatus) => void;
  log: Log;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  requestTimeoutMs?: number;
  /** The account this Mac's data was last used with (settings.account.owner). */
  owner?: {
    get(): { id: string; email: string } | null;
    set(owner: { id: string; email: string }): void;
  };
  /** How much Murmur data this Mac holds (counts only). */
  localData?: () => LocalDataCounts;
}

type Res<N extends RouteName> = z.infer<(typeof ROUTES)[N]["res"]>;

interface CallOptions {
  body?: unknown | (() => unknown);
  params?: Record<string, string>;
  query?: Record<string, string>;
}

const ACCESS_SKEW_MS = 30_000;
const ORIGIN_CHANGED_NOTICE =
  "The server address changed, so Murmur signed you out without contacting it. Sign in again.";
const KEEPS_SIGN_IN_NOTICE =
  "Murmur couldn't remove your saved sign-in from this Mac's Keychain, so it may sign you in again at the next start.";

export function localDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d - 1, 12).getTime());
}

/** Milliseconds until a minute past the next local midnight, when yesterday's count is final. */
export function msUntilNextReport(now: number): number {
  const d = new Date(now);
  const next = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    0,
    1,
    0,
  );
  return Math.max(60_000, next.getTime() - now);
}

function invalid(error: z.ZodError): AccountError {
  const key = String(error.issues[0]?.path?.[0] ?? "");
  const message =
    key === "email" ||
    key === "emails" ||
    key === "invites" ||
    key === "confirmEmail"
      ? "Enter a valid email address."
      : key === "code"
        ? "Enter the 6-digit code."
        : key === "token"
          ? "Paste the invite code from the email."
          : key === "name"
            ? "Enter a name."
            : "That isn't valid. Check it and try again.";
  return new AccountError("invalid-input", message);
}

function parseInput<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw invalid(r.error);
  return r.data;
}

/** Routes that send an email before answering: the server may need a while to reach the mail provider. */
const SENDS_EMAIL: ReadonlySet<string> = new Set([
  "authStart",
  "createTeam",
  "inviteToTeam",
  "referralInvite",
]);
const SLOW_MESSAGE = "Murmur's server didn't answer in time. Try again.";

export class AccountService {
  private readonly deps: AccountDeps;
  private phase: AccountStatus["phase"] = "signed-out";
  private me: Me | null = null;
  private team: AccountStatus["team"] = null;
  private billing: AccountStatus["billing"] = null;
  private referrals: AccountStatus["referrals"] = null;
  private offline = false;
  private keychain: AccountStatus["keychain"] = "ok";
  private notice: string | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshToken: string | null = null;
  /** The server address that issued `refreshToken`; the token is never sent anywhere else. */
  private tokenOrigin: string | null = null;
  private refreshing: Promise<void> | null = null;
  private restoring: Promise<void> | null = null;
  private readonly reported = new Map<string, number>();
  private usage: AccountStatus["usage"] = { day: null, words: null, at: null };
  private switchPrompt: AccountSwitchPrompt | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(deps: AccountDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  snapshot(): AccountStatus {
    const check = checkServerUrl(this.deps.serverUrl(), {
      packaged: this.deps.packaged,
    });
    return {
      phase: this.phase,
      me: this.me,
      team: this.team,
      billing: this.billing,
      referrals: this.referrals,
      offline: this.offline,
      keychain: this.keychain,
      notice: this.notice,
      serverHost: check.ok ? new URL(check.url).host : "",
      usage: this.usage,
      switchPrompt: this.switchPrompt,
    };
  }

  private emit(): AccountStatus {
    const s = this.snapshot();
    if (!this.disposed) this.deps.notify(s);
    return s;
  }

  dispose(): void {
    this.disposed = true;
    this.stopUsageTimer();
  }

  private base(): string {
    const check = checkServerUrl(this.deps.serverUrl(), {
      packaged: this.deps.packaged,
    });
    if (!check.ok)
      throw new AccountError(
        "server-url",
        "The server address in Murmur's settings isn't allowed. Use an https:// address.",
      );
    return check.url;
  }

  private async send(
    name: RouteName,
    opts: CallOptions,
    token: string | null,
  ): Promise<unknown> {
    const route = ROUTES[name] as {
      method: string;
      path: string;
      req: z.ZodType | null;
      res: z.ZodType;
    };
    let path = route.path;
    for (const [k, v] of Object.entries(opts.params ?? {}))
      path = path.replace(`:${k}`, encodeURIComponent(v));
    const query = opts.query
      ? `?${new URLSearchParams(opts.query).toString()}`
      : "";
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (route.req) {
      const raw = typeof opts.body === "function" ? opts.body() : opts.body;
      body = JSON.stringify(parseInput(route.req, raw));
      headers["Content-Type"] = "application/json";
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const base = this.base();
    if (
      this.tokenOrigin !== null &&
      base !== this.tokenOrigin &&
      (token || name === "authRefresh" || name === "authSignOut")
    ) {
      this.endSession(ORIGIN_CHANGED_NOTICE);
      throw new AccountError("signed-out", ORIGIN_CHANGED_NOTICE);
    }
    let res: Response;
    try {
      res = await this.deps.fetch(`${base}${API_PREFIX}${path}${query}`, {
        method: route.method,
        headers,
        body,
        redirect: "error", // a redirect would carry the token to another address
        signal: AbortSignal.timeout(
          this.deps.requestTimeoutMs ??
            (SENDS_EMAIL.has(name) ? 40_000 : 15_000),
        ),
      });
    } catch (e) {
      if (e instanceof AccountError) throw e;
      // The server is there but slow (e.g. still sending an email): say so, not "can't reach".
      if (e instanceof Error && e.name === "TimeoutError")
        throw new AccountError("offline", SLOW_MESSAGE);
      throw new AccountError("offline", OFFLINE_MESSAGE);
    }
    let json: unknown = null;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const parsed = ErrorBody.safeParse(json);
      const code = parsed.success
        ? parsed.data.code
        : codeForStatus(res.status);
      throw new AccountError(
        code,
        friendlyMessage(code, parsed.success ? parsed.data.message : ""),
        res.status,
      );
    }
    const ok = route.res.safeParse(json);
    if (!ok.success)
      throw new AccountError(
        "invalid-response",
        "Murmur's server answered in a way this version doesn't understand. Update Murmur and try again.",
        res.status,
      );
    return ok.data;
  }

  private setOffline(offline: boolean): void {
    if (this.offline === offline) return;
    this.offline = offline;
    this.emit();
  }

  /** A signed-in request: refreshes the access token when needed, and once after a 401. */
  private async call<N extends RouteName>(
    name: N,
    opts: CallOptions = {},
  ): Promise<Res<N>> {
    const auth = ROUTES[name].auth;
    let retried = false;
    for (;;) {
      const token = auth ? await this.ensureAccess() : null;
      try {
        const result = (await this.send(name, opts, token)) as Res<N>;
        this.setOffline(false);
        return result;
      } catch (e) {
        if (!(e instanceof AccountError)) throw e;
        if (e.code === "offline") this.setOffline(true);
        if (auth && e.code === "unauthorized") {
          if (!retried) {
            retried = true;
            this.access = null;
            await this.refreshTokens();
            continue;
          }
          this.endSession("Your session ended. Sign in again.");
        }
        throw e;
      }
    }
  }

  private async ensureAccess(): Promise<string> {
    if (!this.refreshToken)
      throw new AccountError(
        "signed-out",
        "Sign in to use your Murmur account.",
      );
    if (this.access && this.access.expiresAt - ACCESS_SKEW_MS > this.now())
      return this.access.token;
    await this.refreshTokens();
    return this.access!.token;
  }

  private refreshTokens(): Promise<void> {
    this.refreshing ??= (async () => {
      const refreshToken = this.refreshToken;
      if (!refreshToken)
        throw new AccountError(
          "signed-out",
          "Sign in to use your Murmur account.",
        );
      try {
        const { tokens } = (await this.send(
          "authRefresh",
          { body: { refreshToken } },
          null,
        )) as Res<"authRefresh">;
        this.setOffline(false);
        this.adopt(tokens);
        await this.persist(tokens.refreshToken);
      } catch (e) {
        if (e instanceof AccountError) {
          if (e.code === "offline") this.setOffline(true);
          else if (e.code === "unauthorized" || e.code === "forbidden")
            this.endSession("Your session ended. Sign in again.");
        }
        throw e;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private adopt(tokens: Res<"authRefresh">["tokens"]): void {
    this.access = {
      token: tokens.accessToken,
      expiresAt: Date.parse(tokens.accessExpiresAt),
    };
    this.refreshToken = tokens.refreshToken;
    this.tokenOrigin = this.base();
  }

  private async persist(token: string): Promise<void> {
    try {
      await this.deps.vault.save(token, this.tokenOrigin ?? this.base());
    } catch {
      this.deps.log("account.token.save-failed");
    }
  }

  private endSession(notice: string | null): void {
    // The session ends in memory first: a Keychain or file that won't answer must not keep it alive.
    this.access = null;
    this.refreshToken = null;
    this.tokenOrigin = null;
    let cleared = true;
    try {
      this.deps.vault.clear();
    } catch {
      cleared = false;
      this.deps.log("account.token.clear-failed");
    }
    this.phase = "signed-out";
    this.me = null;
    this.team = null;
    this.billing = null;
    this.referrals = null;
    this.offline = false;
    this.notice = cleared
      ? notice
      : [notice, KEEPS_SIGN_IN_NOTICE].filter(Boolean).join(" ");
    this.reported.clear();
    this.usage = { day: null, words: null, at: null };
    this.switchPrompt = null;
    this.stopUsageTimer();
    this.emit();
  }

  // ---- Whose data this Mac holds ----

  /**
   * Run whenever the profile arrives. The same account (or a Mac with no Murmur data) is
   * recorded silently; anyone else is asked, through `switchPrompt`, before using the data.
   */
  private checkOwner(): void {
    const owner = this.deps.owner;
    if (!owner || !this.me) return;
    const { id, email } = this.me;
    const saved = owner.get();
    if (saved?.id === id) {
      if (saved.email !== email) owner.set({ id, email });
      this.switchPrompt = null;
      return;
    }
    // Asked already for this sign-in: the counts don't need recounting on every refresh.
    if (this.switchPrompt) return;
    const counts = this.deps.localData?.();
    if (!counts || Object.values(counts).every((n) => n === 0)) {
      owner.set({ id, email });
      return;
    }
    this.switchPrompt = { previousEmail: saved?.email ?? null, counts };
  }

  /** True while the signed-in account still has to choose keep or start fresh. */
  switchPending(): boolean {
    return this.switchPrompt !== null;
  }

  /** This Mac's data now belongs to the signed-in account (after keep, or after deleting it). */
  acceptOwner(): AccountStatus {
    if (this.me && this.deps.owner)
      this.deps.owner.set({ id: this.me.id, email: this.me.email });
    this.switchPrompt = null;
    return this.emit();
  }

  // ---- Session ----

  restore(): Promise<void> {
    this.restoring ??= this.doRestore().finally(() => {
      this.restoring = null;
    });
    return this.restoring;
  }

  private async doRestore(): Promise<void> {
    if (this.phase !== "signed-out") return;
    const saved = await this.deps.vault.load();
    if (saved.state === "absent") return;
    if (saved.state !== "ok") {
      this.keychain = "unavailable";
      this.notice =
        "Murmur couldn't read your saved sign-in from the macOS Keychain, so you're signed out. Your dictation is not affected.";
      this.emit();
      return;
    }
    if (saved.origin !== this.base()) {
      // Issued by another server (or by a version that didn't record it): never send it here.
      this.endSession(ORIGIN_CHANGED_NOTICE);
      return;
    }
    this.refreshToken = saved.token;
    this.tokenOrigin = saved.origin;
    this.phase = "restoring";
    this.emit();
    try {
      await this.refreshTokens();
    } catch (e) {
      if (e instanceof AccountError && e.code === "offline") {
        this.phase = "signed-in"; // account screens offer "Try again"
        this.emit();
        return;
      }
      if (this.phase === "restoring") {
        this.phase = "signed-in";
        this.emit();
      }
      return;
    }
    this.phase = "signed-in";
    this.emit();
    await this.loadAll();
    this.ensureUsage();
  }

  async startSignIn(
    input: unknown,
  ): Promise<{ expiresInSec: number; delivery?: "email" | "outbox" }> {
    const body = parseInput(AuthStartRequest, input);
    if (!(await this.deps.vault.available())) {
      this.keychain = "unavailable";
      this.emit();
      throw new AccountError(
        "keychain",
        "Murmur can't use the macOS Keychain, so it can't keep you signed in. Allow Keychain access, then try again.",
      );
    }
    this.keychain = "ok";
    const res = await this.call("authStart", { body });
    return { expiresInSec: res.expiresInSec, delivery: res.delivery };
  }

  /**
   * Development only: the newest sign-in code the server's test outbox holds for this address.
   * Null in packaged builds, when the outbox is off, or when it has nothing.
   */
  async devOutboxCode(email: string): Promise<string | null> {
    if (this.deps.packaged) return null;
    try {
      const url = `${this.base()}${API_PREFIX}/dev/outbox?to=${encodeURIComponent(email.trim().toLowerCase())}&limit=1`;
      const res = await this.deps.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        emails?: { kind?: unknown; code?: unknown }[];
      };
      const first = body.emails?.[0];
      return first?.kind === "sign-in-code" &&
        typeof first.code === "string" &&
        /^\d{6}$/.test(first.code)
        ? first.code
        : null;
    } catch {
      return null;
    }
  }

  async verify(input: unknown): Promise<AccountStatus> {
    const raw = (input ?? {}) as { email?: unknown; code?: unknown };
    const body = parseInput(AuthVerifyRequest, {
      email: raw.email,
      code: raw.code,
      device: {
        name: "Murmur on macOS",
        platform: "macos",
        appVersion: this.deps.appVersion,
      },
    });
    const res = await this.call("authVerify", { body });
    try {
      await this.deps.vault.save(res.tokens.refreshToken, this.base());
    } catch {
      // Stay signed out: a sign-in that can't be kept would vanish at the next start.
      this.keychain = "unavailable";
      this.refreshToken = res.tokens.refreshToken;
      this.access = {
        token: res.tokens.accessToken,
        expiresAt: Date.parse(res.tokens.accessExpiresAt),
      };
      await this.call("authSignOut", {
        body: { refreshToken: res.tokens.refreshToken },
      }).catch(() => {});
      this.refreshToken = null;
      this.access = null;
      this.emit();
      throw new AccountError(
        "keychain",
        "Murmur couldn't save your sign-in in the macOS Keychain, so you're still signed out. Allow Keychain access and try again.",
      );
    }
    this.adopt(res.tokens);
    this.me = res.me;
    this.phase = "signed-in";
    this.keychain = "ok";
    this.notice = null;
    this.checkOwner();
    this.emit();
    await this.loadAll();
    this.ensureUsage();
    return this.snapshot();
  }

  async signOut(): Promise<AccountStatus> {
    if (this.refreshToken) {
      await this.call("authSignOut", {
        body: () => ({ refreshToken: this.refreshToken }),
      }).catch((e: unknown) =>
        this.deps.log("account.signout.server-failed", {
          code: (e as AccountError).code,
        }),
      );
    }
    this.endSession(null);
    return this.snapshot();
  }

  async deleteAccount(input: unknown): Promise<AccountStatus> {
    const body = parseInput(DeleteMeRequest, input);
    if (this.me && body.confirmEmail !== this.me.email)
      throw new AccountError(
        "invalid-input",
        "That isn't the email address of this account.",
      );
    await this.call("deleteMe", { body });
    this.endSession(null);
    return this.snapshot();
  }

  // ---- Loading ----

  async loadAll(): Promise<void> {
    if (!this.refreshToken) return;
    try {
      this.me = await this.call("me");
    } catch (e) {
      this.logFailure("me", e);
      this.emit();
      return;
    }
    this.checkOwner();
    this.emit();
    this.ensureUsage();
    const rest: Promise<unknown>[] = [
      this.call("billing").then((b) => (this.billing = b)),
      this.call("referrals").then((r) => (this.referrals = r)),
      this.me.team
        ? this.call("currentTeam").then((t) => (this.team = t.team))
        : Promise.resolve((this.team = null)),
    ];
    const results = await Promise.allSettled(rest);
    results.forEach((r, i) => {
      if (r.status === "rejected")
        this.logFailure(["billing", "referrals", "team"][i], r.reason);
    });
    this.emit();
  }

  async refresh(): Promise<AccountStatus> {
    if (this.phase === "restoring") await this.restoring;
    else if (this.phase === "signed-in" && !this.access) {
      try {
        await this.refreshTokens();
      } catch {
        return this.snapshot();
      }
    }
    await this.loadAll();
    return this.snapshot();
  }

  private logFailure(what: string, e: unknown): void {
    this.deps.log("account.load.failed", {
      what,
      code: e instanceof AccountError ? e.code : "unknown",
    });
  }

  // ---- Profile, team, referrals, billing: each is one contract route; see ROUTES ----

  async updateProfile(input: unknown): Promise<AccountStatus> {
    this.me = await this.call("updateMe", {
      body: parseInput(UpdateMeRequest, input),
    });
    return this.emit();
  }
  async setAvatar(dataUrl: string): Promise<AccountStatus> {
    this.me = await this.call("setAvatar", {
      body: parseInput(SetAvatarRequest, { dataUrl }),
    });
    return this.emit();
  }
  async removeAvatar(): Promise<AccountStatus> {
    this.me = await this.call("removeAvatar");
    return this.emit();
  }

  private async teamChanged(
    team: AccountStatus["team"],
  ): Promise<AccountStatus> {
    this.team = team;
    this.emit();
    await this.loadAll(); // membership changes the plan (the team trial)
    return this.snapshot();
  }
  async createTeam(input: unknown): Promise<AccountStatus> {
    return this.teamChanged(
      await this.call("createTeam", {
        body: parseInput(CreateTeamRequest, input),
      }),
    );
  }
  async joinTeam(input: unknown): Promise<AccountStatus> {
    return this.teamChanged(
      await this.call("joinTeam", { body: parseInput(JoinTeamRequest, input) }),
    );
  }
  async leaveTeam(): Promise<AccountStatus> {
    await this.call("leaveTeam");
    if (this.me) this.me = { ...this.me, team: null };
    return this.teamChanged(null);
  }
  async inviteToTeam(input: unknown): Promise<AccountStatus> {
    this.team = await this.call("inviteToTeam", {
      body: parseInput(InviteRequest, input),
    });
    return this.emit();
  }
  async revokeInvite(inviteId: string): Promise<AccountStatus> {
    this.team = await this.call("revokeInvite", { params: { inviteId } });
    return this.emit();
  }
  async renameTeam(input: unknown): Promise<AccountStatus> {
    this.team = await this.call("updateTeam", {
      body: parseInput(UpdateTeamRequest, input),
    });
    if (this.me?.team)
      this.me = { ...this.me, team: { ...this.me.team, name: this.team.name } };
    return this.emit();
  }
  async setMemberRole(userId: string, input: unknown): Promise<AccountStatus> {
    this.team = await this.call("setMemberRole", {
      body: parseInput(SetRoleRequest, input),
      params: { userId },
    });
    return this.emit();
  }
  async removeMember(userId: string): Promise<AccountStatus> {
    this.team = await this.call("removeMember", { params: { userId } });
    return this.emit();
  }

  inviteFriends(input: unknown): Promise<{ sent: number }> {
    return this.call("referralInvite", {
      body: parseInput(ReferralInviteRequest, input),
    });
  }
  async applyReferral(input: unknown): Promise<AccountStatus> {
    this.me = (
      await this.call("applyReferral", {
        body: parseInput(ApplyReferralRequest, input),
      })
    ).me;
    this.emit();
    await this.loadAll();
    return this.snapshot();
  }

  plans(interval: BillingInterval): Promise<Res<"plans">> {
    return this.call("plans", { query: { interval } });
  }
  async checkout(input: {
    plan: "pro" | "enterprise";
    interval: BillingInterval;
  }): Promise<Res<"checkout">> {
    const body = parseInput(CheckoutRequest, {
      ...input,
      seats: this.team?.members.length || 1,
    });
    const res = await this.call("checkout", { body });
    if (res.kind === "activated") {
      this.billing = res.billing;
      this.emit();
      await this.loadAll();
    }
    return res;
  }
  async cancelSubscription(): Promise<AccountStatus> {
    this.billing = await this.call("cancelSubscription");
    this.emit();
    await this.loadAll();
    return this.snapshot();
  }
  async applyPromo(input: unknown): Promise<AccountStatus> {
    this.billing = await this.call("applyPromo", {
      body: parseInput(PromoRequest, input),
    });
    this.emit();
    await this.loadAll();
    return this.snapshot();
  }

  // ---- Usage (a daily word count, never text) ----

  async reportUsage(): Promise<void> {
    if (this.phase !== "signed-in" || !this.refreshToken) return;
    const today = localDay(this.now());
    for (const day of [previousDay(today), today]) {
      const words = Math.min(this.deps.wordsOn(day), 1_000_000);
      if (words <= 0 || this.reported.get(day) === words) continue;
      try {
        await this.call("reportUsage", { body: { day, words } });
      } catch (e) {
        this.deps.log("account.usage.failed", {
          code: e instanceof AccountError ? e.code : "unknown",
        });
        return;
      }
      this.reported.set(day, words);
      this.usage = { day, words, at: this.now() };
      this.emit();
    }
  }

  /** Starts reporting after any successful load while signed in, whatever path got us here. */
  private ensureUsage(): void {
    if (
      this.timer !== null ||
      this.disposed ||
      this.phase !== "signed-in" ||
      !this.refreshToken
    )
      return;
    void this.reportUsage();
    this.scheduleUsage();
  }

  private scheduleUsage(): void {
    this.stopUsageTimer();
    if (this.disposed) return;
    const set =
      this.deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.timer = set(() => {
      void this.reportUsage().finally(() => {
        if (this.phase === "signed-in") this.scheduleUsage();
      });
    }, msUntilNextReport(this.now()));
  }

  private stopUsageTimer(): void {
    if (this.timer === null) return;
    (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(
      this.timer,
    );
    this.timer = null;
  }

  /** The test mailbox's address when the server offers one (development builds only). */
  async devOutboxUrl(): Promise<string | null> {
    if (this.deps.packaged) return null;
    try {
      const url = `${this.base()}${API_PREFIX}/dev/outbox`;
      const res = await this.deps.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(4_000),
      });
      return res.ok ? url : null;
    } catch {
      return null;
    }
  }
}
