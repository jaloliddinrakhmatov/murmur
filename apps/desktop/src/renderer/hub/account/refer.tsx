// "Get a free month": share your referral code, see how your friends are doing, or apply a code a
// friend gave you. The rules shown come from the shared contract, and the server decides.
import { useEffect, useState } from "react";
import { Copy, Gift } from "lucide-react";
import { RULES } from "@murmur/account-api";
import type { AccountStatus } from "../../../shared/account.ts";
import { hub } from "../bridge.ts";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  EmptyState,
  Field,
  Input,
  Skeleton,
  UnderlineTabs,
  useToast,
} from "../ui/index.ts";
import {
  creditText,
  isReferralCode,
  normalizeReferralCode,
  parseEmails,
  referralProgress,
  referralProgressText,
  referralShareText,
  referralStatus,
  safeReferralLabel,
} from "../model/account.ts";
import { MurmurMark } from "../shell/shell.tsx";
import { OfflineNotice } from "./offline.tsx";
import { refreshAccount, useAccount, useAction } from "./use-account.ts";

type Tab = "refer" | "past" | "apply";

export function ReferDialog({
  open,
  onOpenChange,
  onSignIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSignIn: () => void;
}) {
  const account = useAccount();
  const [tab, setTab] = useState<Tab>("refer");
  const signedIn = account?.phase === "signed-in";
  useEffect(() => {
    if (open) {
      setTab("refer");
      if (signedIn) void refreshAccount();
    }
  }, [open, signedIn]);
  const referrals = account?.referrals ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="min-h-[520px]">
        <DialogHeader
          title="Get a free month of Murmur Pro"
          description="Refer a friend. You each get a month of Pro."
        />
        {!signedIn ? (
          <DialogBody>
            <EmptyState
              icon={<Gift className="size-5" aria-hidden />}
              title="Sign in to refer a friend"
              description="Your referral code and your referrals belong to your Murmur account. Dictation and everything else stays on this Mac."
              action={
                <Button variant="primary" onClick={onSignIn}>
                  Sign in
                </Button>
              }
            />
          </DialogBody>
        ) : (
          <>
            <UnderlineTabs<Tab>
              label="Referrals"
              value={tab}
              onChange={setTab}
              options={[
                { value: "refer", label: "Refer" },
                {
                  value: "past",
                  label: `Past referrals (${referrals?.referrals.length ?? 0})`,
                },
                { value: "apply", label: "Apply referral" },
              ]}
            />
            <DialogBody className="pt-5">
              {account?.offline && (
                <div className="mb-4">
                  <OfflineNotice />
                </div>
              )}
              {!referrals ? (
                <div className="space-y-3" aria-busy>
                  <Skeleton className="h-24" />
                  <Skeleton className="h-24" />
                </div>
              ) : tab === "refer" ? (
                <ReferTab account={account!} />
              ) : tab === "past" ? (
                <PastTab referrals={referrals.referrals} />
              ) : (
                <ApplyTab account={account!} />
              )}
            </DialogBody>
            <p className="mt-5 shrink-0 border-t border-hairline pt-4 text-caption text-fg-secondary">
              Free months from referrals are credit on your account. They apply
              at your next renewal.
              {referrals &&
                referrals.creditMonths > 0 &&
                ` You have ${creditText(referrals.creditMonths)} in credit.`}
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function GiftCard() {
  return (
    <div
      aria-hidden
      className="relative flex h-full min-h-44 flex-col justify-between overflow-hidden rounded-xl bg-accent-soft p-5"
    >
      <div className="absolute -right-8 -top-10 size-36 rounded-full bg-accent/25" />
      <div className="absolute -bottom-12 -left-6 size-32 rounded-full bg-accent/20" />
      <MurmurMark className="relative size-9" />
      <div className="relative">
        <div className="font-serif text-display leading-none text-fg">
          {RULES.referralRewardMonths} month
        </div>
        <div className="mt-1 text-ui font-medium text-fg">of Murmur Pro</div>
        <div className="mt-3 text-caption text-fg-secondary">
          For you and your friend
        </div>
      </div>
    </div>
  );
}

function ReferTab({ account }: { account: AccountStatus }) {
  const toast = useToast();
  const referrals = account.referrals!;
  const [emails, setEmails] = useState("");
  const send = useAction();
  const parsed = parseEmails(emails);
  const problem = parsed.invalid.length
    ? `These don't look like email addresses: ${parsed.invalid.join(", ")}`
    : parsed.tooMany
      ? `Send up to ${RULES.maxInvitesPerRequest} invites at a time.`
      : null;

  const copy = async () => {
    try {
      await hub.copyText(referralShareText(referrals.code));
      toast({ title: "Code copied", tone: "success" });
    } catch {
      toast({ title: "Couldn't copy the code", tone: "error" });
    }
  };
  const sendInvites = async () => {
    const res = await send.run(() => hub.referralInvite(parsed.valid));
    if (!res) return;
    setEmails("");
    toast({
      title: res.sent === 1 ? "Invite sent" : `${res.sent} invites sent`,
      tone: "success",
    });
    void refreshAccount();
  };

  return (
    <div className="grid grid-cols-[minmax(0,260px)_minmax(0,1fr)] gap-6 max-[640px]:grid-cols-1">
      <GiftCard />
      <div className="space-y-5">
        <section aria-labelledby="how-it-works">
          <h3 id="how-it-works" className="text-ui font-semibold text-fg">
            How it works
          </h3>
          <ol className="mt-2 space-y-2.5">
            {[
              `Share your code: ${referrals.code}. Your friend enters it in Murmur under Get a free month → Apply referral.`,
              `They get ${RULES.referralRewardMonths} month of Pro.`,
              `When they've dictated ${RULES.referralRewardWords.toLocaleString()} words, you get ${RULES.referralRewardMonths} month of Pro too.`,
            ].map((text, i) => (
              <li key={i} className="flex gap-3 text-ui text-fg">
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-strong text-caption font-semibold"
                >
                  {i + 1}
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </section>
        <Field label="Your referral code">
          {({ id }) => (
            <div className="flex gap-2">
              <Input
                id={id}
                readOnly
                value={referrals.code}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                icon={<Copy className="size-3.5" aria-hidden />}
                onClick={() => void copy()}
              >
                Copy code
              </Button>
            </div>
          )}
        </Field>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed.valid.length && !problem && !send.busy)
              void sendInvites();
          }}
        >
          <Field
            label="Invite by email"
            hint="Separate addresses with commas or spaces."
            error={problem ?? send.error}
          >
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={problem || send.error ? true : undefined}
                  type="text"
                  inputMode="email"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="friend@example.com"
                  value={emails}
                  onChange={(e) => {
                    setEmails(e.target.value);
                    send.clearError();
                  }}
                />
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!parsed.valid.length || Boolean(problem)}
                  loading={send.busy}
                >
                  Send invites
                </Button>
              </div>
            )}
          </Field>
        </form>
      </div>
    </div>
  );
}

function PastTab({
  referrals,
}: {
  referrals: NonNullable<AccountStatus["referrals"]>["referrals"];
}) {
  if (!referrals.length)
    return (
      <EmptyState
        icon={<Gift className="size-5" aria-hidden />}
        title="No referrals yet"
        description="When a friend applies your code, they appear here with how far they've come."
      />
    );
  return (
    <ul
      aria-label="Past referrals"
      className="divide-y divide-hairline overflow-hidden rounded-list border border-hairline"
    >
      {referrals.map((r) => {
        const status = referralStatus(r.status);
        const progress = referralProgress(r.words);
        return (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">
                {safeReferralLabel(r.label)}
              </span>
              <Badge tone={status.tone}>{status.label}</Badge>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div
                role="progressbar"
                aria-label={`${safeReferralLabel(r.label)}: progress toward ${progress.goal.toLocaleString()} words`}
                aria-valuemin={0}
                aria-valuemax={progress.goal}
                aria-valuenow={progress.words}
                aria-valuetext={referralProgressText(r)}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-strong"
              >
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <span className="w-40 shrink-0 text-right text-caption text-fg-secondary">
                {referralProgressText(r)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ApplyTab({ account }: { account: AccountStatus }) {
  const toast = useToast();
  const applied = account.referrals?.applied ?? null;
  const [code, setCode] = useState("");
  const apply = useAction();
  const submit = async () => {
    const res = await apply.run(() => hub.referralApply(code));
    if (!res) return;
    setCode("");
    toast({
      title: "Code applied",
      description: `${RULES.referralRewardMonths} month of Pro was added as credit.`,
      tone: "success",
    });
  };
  return (
    <div className="max-w-md space-y-4">
      <p className="text-ui text-fg-secondary">
        Got a code from a friend? Apply it within the first{" "}
        {RULES.referralApplyWindowDays} days of your account. You can't use your
        own code.
      </p>
      {applied ? (
        <p
          role="status"
          className="rounded-md bg-success-soft px-3 py-2.5 text-ui text-fg"
        >
          You applied the code{" "}
          <span className="font-medium">{applied.code}</span> on{" "}
          {new Date(applied.at).toLocaleDateString()}.
        </p>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (isReferralCode(code) && !apply.busy) void submit();
          }}
        >
          <Field label="Referral code" error={apply.error}>
            {({ id, describedBy }) => (
              <div className="flex gap-2">
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={apply.error ? true : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="FRIEND123"
                  className="font-mono uppercase"
                  value={code}
                  onChange={(e) => {
                    setCode(normalizeReferralCode(e.target.value));
                    apply.clearError();
                  }}
                />
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!isReferralCode(code)}
                  loading={apply.busy}
                >
                  Apply
                </Button>
              </div>
            )}
          </Field>
        </form>
      )}
    </div>
  );
}
