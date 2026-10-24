// Account screens' logic (Stage B), kept out of the components so it can be unit-tested: names
// and initials, email lists, sign-in codes, referral progress and status, plan prices and
// buttons, and who may do what in a team. Pure; the server stays authoritative for every rule.
import { RULES } from "@murmur/account-api";
import type {
  BillingResponse,
  LocalDataCounts,
  Me,
  PlansResponse,
  ReferralsResponse,
  Team,
} from "../../../shared/account.ts";
import type { Tone } from "./tone.ts";

// ---- Names and email ----

/** "Sam Rivera", or the part of the email before the @ while no name is set. */
export function displayName(
  me: Pick<Me, "firstName" | "lastName" | "email">,
): string {
  const full = `${me.firstName} ${me.lastName}`.trim();
  return full || me.email.split("@")[0];
}

/** Up to two capital letters for the avatar button. */
export function initials(
  me: Pick<Me, "firstName" | "lastName" | "email">,
): string {
  const first = me.firstName.trim()[0];
  const last = me.lastName.trim()[0];
  const letters = first && last ? first + last : (first ?? me.email[0] ?? "?");
  return letters.toUpperCase();
}

/** j***@gmail.com: enough to recognise, never the whole address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email;
  return `${email[0]}***${email.slice(at)}`;
}

const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;

export function isEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= 254 && EMAIL_RE.test(v);
}

/** Referral labels are a first name or a masked address; a full address is masked here too. */
export function safeReferralLabel(label: string): string {
  return isEmail(label) ? maskEmail(label) : label;
}

export interface EmailList {
  valid: string[];
  invalid: string[];
  /** More addresses than one request may carry. */
  tooMany: boolean;
}

/** Addresses separated by commas, semicolons, spaces or new lines (a pasted list). */
export function parseEmails(
  text: string,
  limit: number = RULES.maxInvitesPerRequest,
): EmailList {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const v = part.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    (isEmail(v) ? valid : invalid).push(v);
  }
  return { valid, invalid, tooMany: valid.length > limit };
}

/** Rows of single address fields (Create team): blanks are ignored. */
export function emailsFromRows(rows: string[]): EmailList {
  return parseEmails(rows.join("\n"));
}

// ---- Sign-in code and referral code ----

/** Digits only, at most six: pasting "123 456" or "123-456" works. */
export function normalizeCode(input: string): string {
  return input.replace(/\D/g, "").slice(0, RULES.signInCodeLength);
}

export const isCompleteCode = (code: string): boolean =>
  code.length === RULES.signInCodeLength;

export const RESEND_SECONDS = 30;

/** Seconds until "Send a new code" is allowed again (0 when it is). */
export function resendWait(sentAt: number, now: number): number {
  return Math.max(0, Math.ceil(RESEND_SECONDS - (now - sentAt) / 1000));
}

export const NEWEST_CODE_NOTE =
  "Only the newest code works. Asking for a new one cancels the old one.";

/** What the code step says about where the code went; never claims an email that wasn't sent. */
export function codeSentCopy(
  delivery: "email" | "outbox",
  email: string,
): { before: string; email: string | null; after: string } {
  return delivery === "email"
    ? {
        before: "We emailed a 6-digit code to ",
        email,
        after: ". It works for 10 minutes.",
      }
    : {
        before:
          "Email isn't set up on this server yet. Your code is in the test outbox.",
        email: null,
        after: "",
      };
}

/** Letters and digits, upper case (the contract's referral code). */
export function normalizeReferralCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export const isReferralCode = (code: string): boolean =>
  /^[A-Z0-9]{4,20}$/.test(code);

/** What "Copy" puts on the clipboard for a referral: the code and where a friend enters it. */
export function referralShareText(code: string): string {
  return `Try Murmur, the dictation app for Mac. After you install it and make an account, open "Get a free month" → Apply referral and enter my code: ${code}`;
}

/** Invite codes may be pasted as the code alone or with surrounding text or a link: keep the code. */
export function inviteTokenFrom(input: string): string {
  const t = input.trim();
  try {
    const u = new URL(t);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return (
      u.searchParams.get("token") ?? u.searchParams.get("code") ?? last ?? t
    );
  } catch {
    return t;
  }
}

// ---- Referrals ----

export interface ReferralProgress {
  words: number;
  goal: number;
  /** 0–100, rounded down so it never reads 100 before the goal. */
  percent: number;
  remaining: number;
  done: boolean;
}

export function referralProgress(
  words: number,
  goal: number = RULES.referralRewardWords,
): ReferralProgress {
  const w = Math.max(0, Math.floor(words));
  return {
    words: Math.min(w, goal),
    goal,
    percent: Math.min(100, Math.floor((w / goal) * 100)),
    remaining: Math.max(0, goal - w),
    done: w >= goal,
  };
}

type ReferralStatus = ReferralsResponse["referrals"][number]["status"];

export function referralStatus(status: ReferralStatus): {
  label: string;
  tone: Tone;
} {
  switch (status) {
    case "signed-up":
      return { label: "Signed up", tone: "neutral" };
    case "qualified":
      return { label: "Reached the goal", tone: "accent" };
    case "rewarded":
      return { label: "Month earned", tone: "success" };
  }
}

export function referralProgressText(
  r: Pick<ReferralsResponse["referrals"][number], "words" | "status">,
): string {
  const p = referralProgress(r.words);
  if (r.status === "rewarded") return "Reward given";
  if (p.done) return `${p.goal.toLocaleString()} words reached`;
  return `${p.words.toLocaleString()} of ${p.goal.toLocaleString()} words`;
}

export function creditText(months: number): string {
  return months === 1 ? "1 month of Pro" : `${months} months of Pro`;
}

// ---- Plans ----

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);

type Plan = PlansResponse["plans"][number];

export interface PriceText {
  /** "$12", "From $30", "Free", "Contact us". */
  amount: string;
  /** "per user / month" under the amount; empty for free and contact. */
  unit: string;
}

export function priceText(plan: Plan, currency: string): PriceText {
  if (plan.priceCents === null) return { amount: "Contact us", unit: "" };
  if (plan.priceCents === 0) return { amount: "Free", unit: "" };
  const amount = money(plan.priceCents, currency);
  return {
    amount: plan.priceIsFrom ? `From ${amount}` : amount,
    unit: "per user / month",
  };
}

export type PlanButton =
  | { kind: "current"; label: string }
  | { kind: "select"; label: string }
  | { kind: "contact"; label: string }
  /** Nothing to press: the free plan is what you return to by cancelling. */
  | { kind: "none"; label: string };

/** What a plan column's button does, given the plan you are on. */
export function planButton(
  plan: Plan,
  current: BillingResponse["plan"]["tier"],
): PlanButton {
  if (plan.id === current) return { kind: "current", label: "Current plan" };
  if (plan.id === "free")
    return { kind: "none", label: "Included when you cancel" };
  if (plan.id === "enterprise")
    return { kind: "contact", label: "Contact sales" };
  return {
    kind: "select",
    label: current === "enterprise" ? "Switch to Pro" : "Select plan",
  };
}

const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** One line about the plan you are on and why. */
export function planSummary(plan: BillingResponse["plan"]): string {
  const name =
    plan.tier === "free" ? "Free" : plan.tier === "pro" ? "Pro" : "Enterprise";
  if (plan.source === "none" || plan.tier === "free") return `${name} plan`;
  const until = plan.until ? ` until ${date(plan.until)}` : "";
  switch (plan.source) {
    case "trial":
      return `${name}, team trial${until}`;
    case "referral":
      return `${name}, from referral credit${until}`;
    default:
      return plan.until ? `${name}, renews ${date(plan.until)}` : name;
  }
}

/** Subscription status in words, including a pending cancellation. */
export function subscriptionText(
  sub: NonNullable<BillingResponse["subscription"]>,
): string {
  const end = date(sub.currentPeriodEnd);
  const seats = `${sub.seats} ${sub.seats === 1 ? "seat" : "seats"}`;
  const every = sub.interval === "annual" ? "billed yearly" : "billed monthly";
  if (sub.status === "past_due")
    return `Payment is overdue · ${seats}, ${every}`;
  if (sub.cancelAtPeriodEnd || sub.status === "canceled")
    return `Ends ${end} · ${seats}`;
  return `Renews ${end} · ${seats}, ${every}`;
}

export function trialDaysLeft(
  trialEndsAt: string | null,
  now: number,
): number | null {
  if (!trialEndsAt) return null;
  const ms = Date.parse(trialEndsAt) - now;
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

// ---- Team permissions (the server is authoritative; this only decides what to offer) ----

type Role = Team["role"];

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export const canInvite = (role: Role) => role === "owner" || role === "admin";
export const canRename = (role: Role) => role === "owner";
export const canLeave = (role: Role) => role !== "owner";

export interface MemberActions {
  /** The role this member could be given instead, if their role can be changed. */
  setRole: "admin" | "member" | null;
  remove: boolean;
}

/** What `actor` may do to `target`: owners manage admins and members, admins remove members. */
export function memberActions(
  actor: Role,
  target: { role: Role; isSelf: boolean },
): MemberActions {
  if (target.isSelf || target.role === "owner")
    return { setRole: null, remove: false };
  if (actor === "owner")
    return {
      setRole: target.role === "admin" ? "member" : "admin",
      remove: true,
    };
  if (actor === "admin" && target.role === "member")
    return { setRole: null, remove: true };
  return { setRole: null, remove: false };
}

const ROLE_ORDER: Record<Role, number> = { owner: 0, admin: 1, member: 2 };

export function sortMembers(members: Team["members"]): Team["members"] {
  return [...members].sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      (a.name || a.email).localeCompare(b.name || b.email),
  );
}

export function pendingInvites(team: Team): Team["invites"] {
  return team.invites.filter((i) => i.status === "pending");
}

export function memberLabel(m: Team["members"][number]): string {
  return m.name.trim() || m.email.split("@")[0];
}

// ---- Another account on this Mac ----

/** "312 dictations, 4 notes and 15 dictionary words": what this Mac holds, zeros left out. */
export function localDataSummary(counts: LocalDataCounts): string {
  const parts = (
    [
      [counts.dictations, "dictation", "dictations"],
      [counts.notes, "note", "notes"],
      [counts.meetings, "meeting", "meetings"],
      [counts.dictionary, "dictionary word", "dictionary words"],
      [counts.snippets, "snippet", "snippets"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(
      ([n, one, many]) =>
        `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`,
    );
  if (parts.length <= 1) return parts[0] ?? "no data";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
