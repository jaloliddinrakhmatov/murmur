// What the Hub sees of the Murmur account (Stage B). The main process owns the tokens and talks
// to the server; the window only receives this snapshot and asks for actions. Types come from the
// shared contract (@murmur/account-api), so both sides agree on every field.
import type { z } from "zod";
import type {
  BillingInterval,
  BillingResponse as BillingResponseSchema,
  Me,
  PlansResponse as PlansResponseSchema,
  ReferralsResponse as ReferralsResponseSchema,
  Team,
  TeamRole,
} from "@murmur/account-api";

export type BillingResponse = z.infer<typeof BillingResponseSchema>;
export type PlansResponse = z.infer<typeof PlansResponseSchema>;
export type ReferralsResponse = z.infer<typeof ReferralsResponseSchema>;
export type { Me, Team };

export interface AccountStatus {
  /** "restoring": a saved sign-in is being checked with the server at start-up. */
  phase: "signed-out" | "restoring" | "signed-in";
  me: Me | null;
  /** Members and invites; null without a team, or until they are loaded. */
  team: Team | null;
  billing: BillingResponse | null;
  referrals: ReferralsResponse | null;
  /** The last request could not reach the server: everything on this Mac keeps working. */
  offline: boolean;
  /** "unavailable": the macOS Keychain can't keep a sign-in, so signing in is not offered. */
  keychain: "ok" | "unavailable";
  /** Why you are signed out when it wasn't your choice (an ended session). */
  notice: string | null;
  /** The server's host, shown so you can see where Murmur connects. */
  serverHost: string;
  /** The last daily word count sent (a number, never text). */
  usage: { day: string | null; words: number | null; at: number | null };
  /**
   * Someone other than the account this Mac's data was last used with is signed in, and there
   * is data: the Hub asks whether to keep it or start fresh. Null otherwise.
   */
  switchPrompt: AccountSwitchPrompt | null;
}

/** What this Mac holds (counts only), shown before the keep-or-start-fresh choice. */
export interface LocalDataCounts {
  dictations: number;
  notes: number;
  meetings: number;
  dictionary: number;
  snippets: number;
}

export interface AccountSwitchPrompt {
  /** The account the data was last used with; null when no account was recorded yet. */
  previousEmail: string | null;
  counts: LocalDataCounts;
}

export type CheckoutResult =
  | { kind: "activated" }
  /** The payment page was opened in your browser. */
  | { kind: "redirect" }
  | { kind: "contact"; email: string };

export interface AvatarPick {
  /** False when the picker was cancelled. */
  changed: boolean;
}

export interface SignInStart {
  expiresInSec: number;
  /** "email": a real email was sent. "outbox": only the server's test outbox has the code. */
  delivery: "email" | "outbox";
  /** The server offers a test mailbox (development only); never true for a packaged build. */
  devOutbox: boolean;
  /** Development only, when delivery is "outbox": the newest code for this email. */
  devCode: string | null;
}

/** The account actions the Hub can request (each is one validated IPC channel). */
export interface AccountApi {
  accountStatus(): Promise<AccountStatus>;
  /** Fetches your profile, team, plan and referrals; resolves with the new snapshot. */
  accountRefresh(): Promise<AccountStatus>;
  onAccountChanged(cb: (status: AccountStatus) => void): () => void;
  accountStartSignIn(email: string): Promise<SignInStart>;
  accountVerify(email: string, code: string): Promise<AccountStatus>;
  accountSignOut(): Promise<AccountStatus>;
  accountUpdateProfile(names: {
    firstName: string;
    lastName: string;
  }): Promise<AccountStatus>;
  accountPickAvatar(): Promise<AvatarPick>;
  accountRemoveAvatar(): Promise<AccountStatus>;
  /** The person typed their email to confirm. */
  accountDelete(confirmEmail: string): Promise<AccountStatus>;
  /**
   * Answers the switch prompt: "keep" uses this Mac's data with the signed-in account; "fresh"
   * first deletes History, notes, meetings, the dictionary and snippets (settings and keys stay).
   */
  accountResolveSwitch(choice: "keep" | "fresh"): Promise<AccountStatus>;
  /** Opens the development test mailbox in the browser (only when the server offers one). */
  accountOpenOutbox(): Promise<void>;
  teamCreate(name: string, invites: string[]): Promise<AccountStatus>;
  teamInvite(emails: string[]): Promise<AccountStatus>;
  teamRevokeInvite(inviteId: string): Promise<AccountStatus>;
  teamJoin(token: string): Promise<AccountStatus>;
  teamSetRole(
    userId: string,
    role: Exclude<TeamRole, "owner">,
  ): Promise<AccountStatus>;
  teamRemoveMember(userId: string): Promise<AccountStatus>;
  teamLeave(): Promise<AccountStatus>;
  teamRename(name: string): Promise<AccountStatus>;
  referralInvite(emails: string[]): Promise<{ sent: number }>;
  referralApply(code: string): Promise<AccountStatus>;
  billingPlans(interval: BillingInterval): Promise<PlansResponse>;
  billingCheckout(
    plan: "pro" | "enterprise",
    interval: BillingInterval,
  ): Promise<CheckoutResult>;
  billingCancel(): Promise<AccountStatus>;
  billingPromo(code: string): Promise<AccountStatus>;
}
