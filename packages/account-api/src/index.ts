// The contract between the Murmur desktop app and the Murmur server (Stage B: accounts, teams,
// referrals, plans). Both sides import these schemas: the server validates requests with them
// and the desktop client validates responses. Every route is under API_PREFIX and, except the
// auth routes, needs `Authorization: Bearer <accessToken>`.
//
// Privacy: the server never receives dictations, audio, meeting notes or transcripts. Usage is
// a daily word count, sent only while signed in, for plan limits and referral rewards.
import { z } from "zod";

export { PLAN_CATALOG, plansFor } from "./plans.ts";
export type { CatalogPlan } from "./plans.ts";

export const API_PREFIX = "/v1";

// ---- Shared values ----

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
/**
 * People's names (and team names) end up in emails, so control and format characters
 * (newlines, tabs, zero-width and bidi marks) are refused. Ordinary spaces are fine.
 */
const NO_CONTROL_CHARS = /^[^\p{Cc}\p{Cf}]*$/u;
const plainText = (schema: z.ZodString) =>
  schema.regex(NO_CONTROL_CHARS, "Use letters, digits, punctuation and spaces");
export const NameSchema = plainText(z.string().trim().max(60));
export const TeamNameSchema = plainText(z.string().trim().min(1).max(60));
export const PLAN_IDS = ["free", "pro", "enterprise"] as const;
export const PlanIdSchema = z.enum(PLAN_IDS);
export type PlanId = z.infer<typeof PlanIdSchema>;
export const BILLING_INTERVALS = ["monthly", "annual"] as const;
export const BillingIntervalSchema = z.enum(BILLING_INTERVALS);
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;
export const TEAM_ROLES = ["owner", "admin", "member"] as const;
export const TeamRoleSchema = z.enum(TEAM_ROLES);
export type TeamRole = z.infer<typeof TeamRoleSchema>;
/** Referral codes: letters and digits, e.g. SAMANTHA9. */
export const ReferralCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4,20}$/, "Use the letters and digits of the code");
/** ISO 8601 timestamps on the wire. */
const When = z.string().datetime();

/** Rules shared by both sides (the server is authoritative). */
export const RULES = {
  /** Sign-in codes: 6 digits, valid 10 minutes, 5 tries. */
  signInCodeLength: 6,
  signInCodeMinutes: 10,
  signInCodeAttempts: 5,
  /** A referred friend must dictate this many words before the referrer is rewarded. */
  referralRewardWords: 2000,
  /** Months of Pro: given to the friend on sign-up, and to the referrer when the friend qualifies. */
  referralRewardMonths: 1,
  /** A code can be applied only by an account this young, and never your own. */
  referralApplyWindowDays: 30,
  /** Creating a team starts a Pro trial for the team. */
  teamTrialDays: 14,
  teamInviteDays: 14,
  maxInvitesPerRequest: 20,
  avatarMaxBytes: 1_000_000,
} as const;

// ---- Auth (no access token needed) ----

export const DeviceSchema = z.object({
  name: z.string().trim().max(80),
  platform: z.enum(["macos", "windows", "linux"]),
  appVersion: z.string().max(40),
});

export const AuthStartRequest = z.object({ email: EmailSchema });
export const AuthStartResponse = z.object({
  ok: z.literal(true),
  expiresInSec: z.number().int(),
  /**
   * How the code was delivered: "email" when a real mail provider sent it, "outbox" when only the
   * development outbox has it. The same for every address. Absent on older servers.
   */
  delivery: z.enum(["email", "outbox"]).optional(),
});

export const AuthVerifyRequest = z.object({
  email: EmailSchema,
  code: z.string().regex(/^\d{6}$/),
  device: DeviceSchema,
});

export const TokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  accessExpiresAt: When,
});

export const AuthRefreshRequest = z.object({ refreshToken: z.string() });
export const AuthSignOutRequest = z.object({ refreshToken: z.string() });

// ---- Me ----

export const PlanStateSchema = z.object({
  tier: PlanIdSchema,
  /** Why this tier: none (free), a paid subscription, a team trial, or referral credit. */
  source: z.enum(["none", "subscription", "trial", "referral"]),
  /** When the current paid/trial/credit period ends; null for free or open-ended. */
  until: When.nullable(),
});

export const MeSchema = z.object({
  id: z.string(),
  email: EmailSchema,
  firstName: z.string(),
  lastName: z.string(),
  /** A data URL (image/png or image/jpeg), or null for initials. */
  avatar: z.string().nullable(),
  createdAt: When,
  plan: PlanStateSchema,
  referralCode: z.string(),
  team: z
    .object({ id: z.string(), name: z.string(), role: TeamRoleSchema })
    .nullable(),
});
export type Me = z.infer<typeof MeSchema>;

export const AuthVerifyResponse = z.object({
  tokens: TokensSchema,
  me: MeSchema,
});
export const AuthRefreshResponse = z.object({ tokens: TokensSchema });

export const UpdateMeRequest = z.object({
  firstName: NameSchema.optional(),
  lastName: NameSchema.optional(),
});
export const SetAvatarRequest = z.object({
  /** data:image/png;base64,… or data:image/jpeg;base64,…, at most RULES.avatarMaxBytes decoded. */
  dataUrl: z
    .string()
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/)
    .max(Math.ceil((RULES.avatarMaxBytes * 4) / 3) + 40),
});
export const DeleteMeRequest = z.object({
  /** The account's email, typed again to confirm. */
  confirmEmail: EmailSchema,
});

// ---- Teams ----

export const TeamMemberSchema = z.object({
  userId: z.string(),
  email: EmailSchema,
  name: z.string(),
  role: TeamRoleSchema,
  joinedAt: When,
});
export const TeamInviteSchema = z.object({
  id: z.string(),
  email: EmailSchema,
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  createdAt: When,
  expiresAt: When,
});
export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Your role in it. */
  role: TeamRoleSchema,
  trialEndsAt: When.nullable(),
  members: z.array(TeamMemberSchema),
  /** Only owners and admins see invites. */
  invites: z.array(TeamInviteSchema),
});
export type Team = z.infer<typeof TeamSchema>;

const InviteEmails = z
  .array(EmailSchema)
  .min(1)
  .max(RULES.maxInvitesPerRequest);

export const CreateTeamRequest = z.object({
  name: TeamNameSchema,
  invites: z.array(EmailSchema).max(RULES.maxInvitesPerRequest).default([]),
});
export const InviteRequest = z.object({ emails: InviteEmails });
/** The invite code from the email (also the token in an invite link). */
export const JoinTeamRequest = z.object({
  token: z.string().trim().min(8).max(100),
});
export const UpdateTeamRequest = z.object({
  name: TeamNameSchema,
});
export const SetRoleRequest = z.object({ role: z.enum(["admin", "member"]) });
/** GET /teams/current: your team, or null. */
export const CurrentTeamResponse = z.object({ team: TeamSchema.nullable() });

// ---- Referrals ----

export const ReferralSchema = z.object({
  id: z.string(),
  /** The friend's first name, or a masked email (j***@gmail.com): never the full address. */
  label: z.string(),
  status: z.enum(["signed-up", "qualified", "rewarded"]),
  /** Progress toward RULES.referralRewardWords. */
  words: z.number().int().nonnegative(),
  createdAt: When,
  rewardedAt: When.nullable(),
});
export const ReferralsResponse = z.object({
  code: z.string(),
  link: z.string(),
  referrals: z.array(ReferralSchema),
  /** The code you applied yourself, if any. */
  applied: z.object({ code: z.string(), at: When }).nullable(),
  /** Unused months of Pro earned from referrals. */
  creditMonths: z.number().int().nonnegative(),
});
export const ReferralInviteRequest = z.object({ emails: InviteEmails });
export const ReferralInviteResponse = z.object({ sent: z.number().int() });
export const ApplyReferralRequest = z.object({ code: ReferralCodeSchema });
export const ApplyReferralResponse = z.object({ me: MeSchema });

// ---- Usage ----

export const UsageRequest = z.object({
  /** Local calendar day, YYYY-MM-DD. The server keeps the largest count reported for a day. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  words: z.number().int().nonnegative().max(1_000_000),
});

// ---- Plans and billing ----

export const PlanSchema = z.object({
  id: PlanIdSchema,
  name: z.string(),
  audience: z.string(),
  /** Per user per month, in cents, for the chosen interval; null = contact us. */
  priceCents: z.number().int().nullable(),
  /** "from" prices (Enterprise). */
  priceIsFrom: z.boolean(),
  /** Discount for annual billing, in percent (0 for monthly). */
  discountPct: z.number().int(),
  features: z.array(z.string()),
});
export const PlansResponse = z.object({
  interval: BillingIntervalSchema,
  currency: z.string(),
  plans: z.array(PlanSchema),
});

// ---- Public (website) ----
// No sign-in. Used by the marketing site; the server rate-limits them and allows CORS only for
// the website origin. They never return an email address.

export const PublicPlansQuery = z.object({
  interval: BillingIntervalSchema.default("monthly"),
});
/** Only `valid`, plus the referrer's first name when they set one (never email or last name). */
export const PublicReferralResponse = z.object({
  valid: z.boolean(),
  firstName: z.string().optional(),
});
export const PublicInviteResponse = z.object({
  valid: z.boolean(),
  teamName: z.string().optional(),
  expired: z.boolean().optional(),
});
export const WaitlistRequest = z.object({
  email: EmailSchema,
  /** Where the form was (e.g. "home", "download"); free text is refused. */
  source: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{1,30}$/)
    .optional(),
});
export const WaitlistResponse = z.object({ ok: z.literal(true) });

// ---- Help chat (website) ----
// The website's AI helper. The server is stateless: the browser sends the whole (short)
// conversation each time, and nothing the visitor writes is stored or logged.

export const HELP_LIMITS = {
  maxMessages: 16,
  maxUserChars: 1500,
  maxAssistantChars: 6000,
} as const;
export const HelpMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.string().trim().min(1).max(HELP_LIMITS.maxUserChars),
  }),
  z.object({
    role: z.literal("assistant"),
    content: z.string().max(HELP_LIMITS.maxAssistantChars),
  }),
]);
/** Which kind of page the visitor is on (never the path: referral codes and invites are in it). */
export const HelpPageSchema = z.enum([
  "home",
  "pricing",
  "download",
  "privacy",
  "terms",
  "referral",
  "join",
  "other",
]);
export const HelpChatRequest = z.object({
  messages: z
    .array(HelpMessageSchema)
    .min(1)
    .max(HELP_LIMITS.maxMessages)
    .refine((list) => list[list.length - 1]?.role === "user", {
      message: "The last message must be the visitor's.",
    }),
  page: HelpPageSchema.optional(),
});
export const HelpStatusResponse = z.object({ available: z.boolean() });
/**
 * POST /public/help/chat answers as server-sent events (text/event-stream): one JSON object per
 * `data:` line, in order: any number of `delta`, then exactly one `done` or `error`.
 * Problems found before streaming starts are ordinary ErrorBody responses (400, 429, 503).
 */
export const HelpChatEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({
    type: z.literal("error"),
    code: z.enum(["help-unavailable", "rate-limited", "server-error"]),
    message: z.string(),
  }),
]);

export const BillingResponse = z.object({
  plan: PlanStateSchema,
  subscription: z
    .object({
      plan: PlanIdSchema,
      interval: BillingIntervalSchema,
      seats: z.number().int().positive(),
      status: z.enum(["active", "canceled", "past_due"]),
      currentPeriodEnd: When,
      cancelAtPeriodEnd: z.boolean(),
    })
    .nullable(),
  creditMonths: z.number().int().nonnegative(),
  promo: z.object({ code: z.string(), description: z.string() }).nullable(),
  /** True while no real payment provider is connected: checkout activates plans without charging. */
  testMode: z.boolean(),
});
export const CheckoutRequest = z.object({
  plan: z.enum(["pro", "enterprise"]),
  interval: BillingIntervalSchema,
  seats: z.number().int().positive().max(1000).default(1),
});
export const CheckoutResponse = z.discriminatedUnion("kind", [
  /** Test mode: the plan is active now; nothing was charged. */
  z.object({ kind: z.literal("activated"), billing: BillingResponse }),
  /** A real provider: open this URL in the browser to pay. */
  z.object({ kind: z.literal("redirect"), url: z.string().url() }),
  /** Enterprise: sales contact. */
  z.object({ kind: z.literal("contact"), email: EmailSchema }),
]);
export const PromoRequest = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,30}$/),
});

// ---- Errors ----

/** Every non-2xx response has this body. `code` is stable; `message` is shown to people. */
export const ErrorBody = z.object({
  code: z.enum([
    "bad-request",
    "unauthorized",
    "forbidden",
    "not-found",
    "conflict",
    "rate-limited",
    "code-invalid",
    "code-expired",
    "referral-own-code",
    "referral-too-late",
    "referral-already-applied",
    "team-exists",
    "team-last-owner",
    /** The team's paid plan has no free seat left (invite or join refused). */
    "seats-full",
    "promo-invalid",
    /** The website's help chat has no AI service configured, or it is over its daily budget. */
    "help-unavailable",
    "server-error",
  ]),
  message: z.string(),
});
export type ErrorCode = z.infer<typeof ErrorBody>["code"];

// ---- Routes ----

/** Method, path (relative to API_PREFIX) and schemas for each route. */
export const ROUTES = {
  authStart: {
    method: "POST",
    path: "/auth/start",
    auth: false,
    req: AuthStartRequest,
    res: AuthStartResponse,
  },
  authVerify: {
    method: "POST",
    path: "/auth/verify",
    auth: false,
    req: AuthVerifyRequest,
    res: AuthVerifyResponse,
  },
  authRefresh: {
    method: "POST",
    path: "/auth/refresh",
    auth: false,
    req: AuthRefreshRequest,
    res: AuthRefreshResponse,
  },
  authSignOut: {
    method: "POST",
    path: "/auth/signout",
    auth: true,
    req: AuthSignOutRequest,
    res: z.object({ ok: z.literal(true) }),
  },

  me: { method: "GET", path: "/me", auth: true, req: null, res: MeSchema },
  updateMe: {
    method: "PATCH",
    path: "/me",
    auth: true,
    req: UpdateMeRequest,
    res: MeSchema,
  },
  setAvatar: {
    method: "PUT",
    path: "/me/avatar",
    auth: true,
    req: SetAvatarRequest,
    res: MeSchema,
  },
  removeAvatar: {
    method: "DELETE",
    path: "/me/avatar",
    auth: true,
    req: null,
    res: MeSchema,
  },
  deleteMe: {
    method: "DELETE",
    path: "/me",
    auth: true,
    req: DeleteMeRequest,
    res: z.object({ ok: z.literal(true) }),
  },

  currentTeam: {
    method: "GET",
    path: "/teams/current",
    auth: true,
    req: null,
    res: CurrentTeamResponse,
  },
  createTeam: {
    method: "POST",
    path: "/teams",
    auth: true,
    req: CreateTeamRequest,
    res: TeamSchema,
  },
  updateTeam: {
    method: "PATCH",
    path: "/teams/current",
    auth: true,
    req: UpdateTeamRequest,
    res: TeamSchema,
  },
  inviteToTeam: {
    method: "POST",
    path: "/teams/current/invites",
    auth: true,
    req: InviteRequest,
    res: TeamSchema,
  },
  revokeInvite: {
    method: "DELETE",
    path: "/teams/current/invites/:inviteId",
    auth: true,
    req: null,
    res: TeamSchema,
  },
  joinTeam: {
    method: "POST",
    path: "/teams/join",
    auth: true,
    req: JoinTeamRequest,
    res: TeamSchema,
  },
  setMemberRole: {
    method: "PATCH",
    path: "/teams/current/members/:userId",
    auth: true,
    req: SetRoleRequest,
    res: TeamSchema,
  },
  removeMember: {
    method: "DELETE",
    path: "/teams/current/members/:userId",
    auth: true,
    req: null,
    res: TeamSchema,
  },
  leaveTeam: {
    method: "POST",
    path: "/teams/current/leave",
    auth: true,
    req: null,
    res: CurrentTeamResponse,
  },

  referrals: {
    method: "GET",
    path: "/referrals",
    auth: true,
    req: null,
    res: ReferralsResponse,
  },
  referralInvite: {
    method: "POST",
    path: "/referrals/invite",
    auth: true,
    req: ReferralInviteRequest,
    res: ReferralInviteResponse,
  },
  applyReferral: {
    method: "POST",
    path: "/referrals/apply",
    auth: true,
    req: ApplyReferralRequest,
    res: ApplyReferralResponse,
  },

  reportUsage: {
    method: "POST",
    path: "/usage",
    auth: true,
    req: UsageRequest,
    res: z.object({ ok: z.literal(true) }),
  },

  /** Query: ?interval=monthly|annual (default monthly). */
  plans: {
    method: "GET",
    path: "/billing/plans",
    auth: true,
    req: null,
    res: PlansResponse,
  },
  publicPlans: {
    method: "GET",
    path: "/public/plans",
    auth: false,
    req: null,
    res: PlansResponse,
  },
  publicReferral: {
    method: "GET",
    path: "/public/referral/:code",
    auth: false,
    req: null,
    res: PublicReferralResponse,
  },
  publicInvite: {
    method: "GET",
    path: "/public/invite/:token",
    auth: false,
    req: null,
    res: PublicInviteResponse,
  },
  waitlist: {
    method: "POST",
    path: "/public/waitlist",
    auth: false,
    req: WaitlistRequest,
    res: WaitlistResponse,
  },
  helpStatus: {
    method: "GET",
    path: "/public/help/status",
    auth: false,
    req: null,
    res: HelpStatusResponse,
  },
  /** Streams HelpChatEvent objects as server-sent events (see HelpChatEvent). */
  helpChat: {
    method: "POST",
    path: "/public/help/chat",
    auth: false,
    req: HelpChatRequest,
    res: HelpChatEvent,
  },
  billing: {
    method: "GET",
    path: "/billing",
    auth: true,
    req: null,
    res: BillingResponse,
  },
  checkout: {
    method: "POST",
    path: "/billing/checkout",
    auth: true,
    req: CheckoutRequest,
    res: CheckoutResponse,
  },
  cancelSubscription: {
    method: "POST",
    path: "/billing/cancel",
    auth: true,
    req: null,
    res: BillingResponse,
  },
  applyPromo: {
    method: "POST",
    path: "/billing/promo",
    auth: true,
    req: PromoRequest,
    res: BillingResponse,
  },
} as const;

export type RouteName = keyof typeof ROUTES;
