// Settings → Plans and Billing (Stage B): the plan you are on, the three plans for the chosen
// billing interval, cancelling at the end of the period, promo codes and referral credit.
// While the server has no payment provider (`testMode`), choosing a plan takes no payment and the
// screen says so wherever a plan can be chosen.
import { useCallback, useEffect, useState } from "react";
import { Check, FlaskConical } from "lucide-react";
import type { BillingInterval } from "@murmur/account-api";
import type { AccountStatus, PlansResponse } from "../../../shared/account.ts";
import { hub } from "../bridge.ts";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  Field,
  InlineAlert,
  Input,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  Skeleton,
  useToast,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import {
  creditText,
  planButton,
  planSummary,
  priceText,
  subscriptionText,
} from "../model/account.ts";
import { OfflineNotice } from "../account/offline.tsx";
import { AccountGate } from "../account/signed-out.tsx";
import {
  useAccount,
  useAction,
  useRefreshOnOpen,
} from "../account/use-account.ts";

export function BillingSection() {
  const account = useAccount();
  useRefreshOnOpen(account);
  return (
    <AccountGate
      account={account}
      what="Your plan, billing and promo codes belong to your Murmur account."
    >
      {(a) => <BillingView account={a} />}
    </AccountGate>
  );
}

function BillingView({ account }: { account: AccountStatus }) {
  const toast = useToast();
  const billing = account.billing;
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [plans, setPlans] = useState<PlansResponse | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [contact, setContact] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [annualDiscount, setAnnualDiscount] = useState(0);

  const loadPlans = useCallback(async (which: BillingInterval) => {
    setPlansError(null);
    try {
      const p = await hub.billingPlans(which);
      setPlans(p);
      if (which === "annual")
        setAnnualDiscount(Math.max(0, ...p.plans.map((x) => x.discountPct)));
    } catch (e) {
      setPlans(null);
      setPlansError(ipcErrorMessage(e));
    }
  }, []);
  useEffect(() => {
    setPlans(null);
    void loadPlans(interval);
  }, [interval, loadPlans, account.offline]);
  useEffect(() => {
    if (annualDiscount === 0)
      void hub
        .billingPlans("annual")
        .then((p) =>
          setAnnualDiscount(Math.max(0, ...p.plans.map((x) => x.discountPct))),
        )
        .catch(() => {});
  }, [annualDiscount]);

  const choose = async (plan: "pro" | "enterprise") => {
    setChoosing(plan);
    try {
      const res = await hub.billingCheckout(plan, interval);
      if (res.kind === "activated")
        toast({
          title: "Pro is active",
          description: billing?.testMode
            ? "Test mode: no payment was taken."
            : undefined,
          tone: "success",
        });
      else if (res.kind === "redirect")
        toast({ title: "Payment page opened in your browser" });
      else setContact(res.email);
    } catch (e) {
      toast({
        title: "Couldn't change your plan",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    } finally {
      setChoosing(null);
    }
  };

  const sub = billing?.subscription ?? null;
  return (
    <>
      {account.offline && <OfflineNotice />}
      {billing?.testMode && (
        <InlineAlert tone="warning" icon={<FlaskConical />}>
          <strong className="font-semibold">
            Test mode — no payment is taken.
          </strong>{" "}
          Choosing a plan switches it on without charging anything.
        </InlineAlert>
      )}

      <SettingsGroup title="Your plan">
        {billing ? (
          <>
            <SettingsRow
              label={planSummary(billing.plan)}
              description={sub ? subscriptionText(sub) : undefined}
              control={
                sub && sub.status !== "canceled" && !sub.cancelAtPeriodEnd ? (
                  <Button onClick={() => setCancelling(true)}>
                    Cancel subscription…
                  </Button>
                ) : undefined
              }
            />
            <SettingsRow
              label="Referral credit"
              description={
                billing.creditMonths > 0
                  ? `${creditText(billing.creditMonths)} in credit. It applies at your next renewal.`
                  : "Refer a friend to earn free months of Pro. Credit applies at your next renewal."
              }
            />
            <SettingsRow
              label="Promo code"
              description={
                billing.promo
                  ? `${billing.promo.code}: ${billing.promo.description}`
                  : "Have a code? Add it to your account."
              }
              control={
                <Button onClick={() => setPromoOpen(true)}>
                  Add promo code
                </Button>
              }
            />
          </>
        ) : (
          <div className="py-5" aria-busy>
            <Skeleton className="h-16" />
          </div>
        )}
      </SettingsGroup>

      <section className="space-y-4" aria-labelledby="plans-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <h3 id="plans-heading" className="text-ui font-semibold text-fg">
            Choose a plan
          </h3>
          <div className="flex items-center gap-2">
            {annualDiscount > 0 && interval === "monthly" && (
              <Badge tone="success">Save {annualDiscount}% yearly</Badge>
            )}
            <SegmentedControl<BillingInterval>
              label="Billing interval"
              value={interval}
              onChange={setInterval}
              options={[
                { value: "monthly", label: "Monthly" },
                { value: "annual", label: "Annual" },
              ]}
            />
          </div>
        </div>
        {plansError ? (
          <InlineAlert
            tone="danger"
            icon={<FlaskConical />}
            action={
              <Button size="sm" onClick={() => void loadPlans(interval)}>
                Try again
              </Button>
            }
          >
            {plansError}
          </InlineAlert>
        ) : !plans ? (
          <div
            className="grid grid-cols-3 gap-3 max-[860px]:grid-cols-1"
            aria-busy
          >
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
            <Skeleton className="h-72" />
          </div>
        ) : (
          <ul
            aria-label="Plans"
            className="grid grid-cols-3 gap-3 max-[1000px]:grid-cols-1"
          >
            {plans.plans.map((plan) => {
              const price = priceText(plan, plans.currency);
              const button = planButton(plan, billing?.plan.tier ?? "free");
              return (
                <li
                  key={plan.id}
                  className={
                    "flex flex-col rounded-card bg-surface p-5 " +
                    (button.kind === "current"
                      ? "shadow-[inset_0_0_0_2px_var(--m-accent)]"
                      : "")
                  }
                >
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-ui font-semibold text-fg">
                      {plan.name}
                    </h4>
                    {button.kind === "current" && (
                      <Badge tone="accent">Current</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-caption text-fg-secondary">
                    {plan.audience}
                  </p>
                  <div className="mt-4">
                    <div className="font-serif text-display leading-none text-fg">
                      {price.amount}
                    </div>
                    <div className="mt-1 min-h-4 text-caption text-fg-secondary">
                      {price.unit}
                      {plan.discountPct > 0 &&
                        ` · ${plan.discountPct}% off yearly`}
                    </div>
                  </div>
                  <ul className="mt-4 flex-1 space-y-2">
                    {plan.features.map((f) => (
                      <li key={f} className="flex gap-2 text-ui text-fg">
                        <Check
                          className="mt-0.5 size-4 shrink-0 text-accent-text"
                          aria-hidden
                        />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-5">
                    {button.kind === "select" || button.kind === "contact" ? (
                      <Button
                        className="w-full"
                        variant={
                          button.kind === "select" ? "primary" : "secondary"
                        }
                        loading={choosing === plan.id}
                        disabled={choosing !== null}
                        aria-label={`${button.label}: ${plan.name}`}
                        onClick={() =>
                          void choose(plan.id as "pro" | "enterprise")
                        }
                      >
                        {button.label}
                      </Button>
                    ) : (
                      <p className="text-center text-caption text-fg-secondary">
                        {button.label}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel your subscription?"
        description={
          sub
            ? `You keep your plan until ${new Date(sub.currentPeriodEnd).toLocaleDateString()}, then return to Free.`
            : "You keep your plan until the end of the period."
        }
        confirmLabel="Cancel subscription"
        destructive
        onConfirm={async () => {
          await hub.billingCancel();
          toast({ title: "Subscription will end at the period's end" });
        }}
      />
      <PromoDialog open={promoOpen} onOpenChange={setPromoOpen} />
      <Dialog
        open={contact !== null}
        onOpenChange={(o) => !o && setContact(null)}
      >
        <DialogContent size="sm">
          <DialogHeader
            title="Contact sales"
            description="Enterprise plans are set up with our team."
          />
          <DialogBody>
            <p className="text-ui text-fg">
              Email <span className="font-medium select-text">{contact}</span>{" "}
              and we'll get back to you.
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              onClick={() => {
                if (contact) void hub.copyText(contact);
                toast({ title: "Address copied", tone: "success" });
              }}
            >
              Copy address
            </Button>
            <Button variant="primary" onClick={() => setContact(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PromoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const apply = useAction();
  useEffect(() => {
    if (!open) {
      setCode("");
      apply.clearError();
    }
  }, [open]);
  const valid = /^[A-Za-z0-9-]{3,30}$/.test(code.trim());
  return (
    <Dialog open={open} onOpenChange={(o) => !apply.busy && onOpenChange(o)}>
      <DialogContent size="sm">
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid || apply.busy) return;
            void apply
              .run(() => hub.billingPromo(code.trim()))
              .then((s) => {
                if (!s) return;
                onOpenChange(false);
                toast({ title: "Promo code added", tone: "success" });
              });
          }}
        >
          <DialogHeader title="Add a promo code" />
          <DialogBody>
            <Field label="Promo code">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  spellCheck={false}
                  className="uppercase"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    apply.clearError();
                  }}
                />
              )}
            </Field>
          </DialogBody>
          <DialogError message={apply.error} />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} disabled={apply.busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!valid}
              loading={apply.busy}
            >
              Add code
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
