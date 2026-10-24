// Settings → Account (Stage B): your name, picture and plan, what Murmur sends the server, and
// signing out or deleting the account. Signed out, it invites you to sign in and does nothing else.
import { useEffect, useRef, useState } from "react";
import type { AccountStatus } from "../../../shared/account.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  SettingsGroup,
  SettingsRow,
  useToast,
  ConfirmDialog,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { displayName, planSummary } from "../model/account.ts";
import type { SettingsSectionId } from "../model/settings-sections.ts";
import { Avatar } from "../account/avatar.tsx";
import { OfflineNotice } from "../account/offline.tsx";
import { AccountGate } from "../account/signed-out.tsx";
import {
  useAccount,
  useAction,
  useRefreshOnOpen,
} from "../account/use-account.ts";

export function AccountSection({
  onSection,
}: {
  onSection: (s: SettingsSectionId) => void;
}) {
  const account = useAccount();
  useRefreshOnOpen(account);
  return (
    <AccountGate
      account={account}
      what="An account lets you share Murmur with a team, earn free months by referring friends, and manage your plan."
    >
      {(a) => <SignedIn account={a} onSection={onSection} />}
    </AccountGate>
  );
}

function SignedIn({
  account,
  onSection,
}: {
  account: AccountStatus;
  onSection: (s: SettingsSectionId) => void;
}) {
  const toast = useToast();
  const me = account.me;
  const [first, setFirst] = useState(me?.firstName ?? "");
  const [last, setLast] = useState(me?.lastName ?? "");
  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const save = useAction();
  const picture = useAction();
  useEffect(() => {
    setFirst(me?.firstName ?? "");
    setLast(me?.lastName ?? "");
  }, [me?.firstName, me?.lastName]);
  if (!me) return null;

  const dirty = first.trim() !== me.firstName || last.trim() !== me.lastName;
  const submit = async () => {
    const ok = await save.run(() =>
      hub.accountUpdateProfile({
        firstName: first.trim(),
        lastName: last.trim(),
      }),
    );
    if (ok) toast({ title: "Profile saved", tone: "success" });
  };
  const changePicture = async () => {
    const res = await picture.run(() => hub.accountPickAvatar());
    if (res?.changed)
      toast({ title: "Profile picture updated", tone: "success" });
  };
  const removePicture = async () => {
    const res = await picture.run(() => hub.accountRemoveAvatar());
    if (res) toast({ title: "Profile picture removed" });
  };

  return (
    <>
      {account.offline && <OfflineNotice />}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !save.busy) void submit();
        }}
      >
        <SettingsGroup title="Profile">
          <SettingsRow
            label="Profile picture"
            description={
              picture.error ??
              "A PNG or JPEG. Murmur crops it to a square and shrinks it."
            }
            control={
              <>
                <Avatar me={me} size="lg" />
                <Button
                  onClick={() => void changePicture()}
                  loading={picture.busy}
                >
                  Change
                </Button>
                {me.avatar && (
                  <Button
                    onClick={() => void removePicture()}
                    disabled={picture.busy}
                  >
                    Remove
                  </Button>
                )}
              </>
            }
          />
          <SettingsRow
            label="First name"
            htmlFor="account-first"
            control={
              <Input
                id="account-first"
                className="w-56"
                autoComplete="given-name"
                maxLength={60}
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              />
            }
          />
          <SettingsRow
            label="Last name"
            htmlFor="account-last"
            control={
              <Input
                id="account-last"
                className="w-56"
                autoComplete="family-name"
                maxLength={60}
                value={last}
                onChange={(e) => setLast(e.target.value)}
              />
            }
          />
          <SettingsRow
            label="Email"
            htmlFor="account-email"
            description="You sign in with this address. It can't be changed here."
            control={
              <Input
                id="account-email"
                className="w-56"
                readOnly
                value={me.email}
              />
            }
          />
          <SettingsRow
            label={
              <span aria-live="polite">
                {save.error ? (
                  <span className="text-danger">{save.error}</span>
                ) : (
                  "Save changes"
                )}
              </span>
            }
            control={
              <Button
                type="submit"
                variant="primary"
                disabled={!dirty}
                loading={save.busy}
              >
                Save
              </Button>
            }
          />
        </SettingsGroup>
      </form>

      <SettingsGroup title="Plan">
        <SettingsRow
          label={planSummary(me.plan)}
          description={
            me.team
              ? `Team: ${me.team.name}`
              : "Compare plans, start a trial or add a promo code."
          }
          control={
            <Button onClick={() => onSection("billing")}>
              Plans and billing
            </Button>
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="What Murmur sends"
        description="Murmur sends your daily word count, never what you said. Dictations, audio, notes and meetings stay on this Mac."
      >
        <SettingsRow
          label="Daily word count"
          description={
            account.usage.at !== null && account.usage.words !== null
              ? `Last sent: ${account.usage.words.toLocaleString()} words for ${account.usage.day}. It counts toward your referral rewards.`
              : "Sent once a day while you're signed in, and counts toward your referral rewards. Nothing has been sent yet."
          }
        />
        <SettingsRow
          label="Server"
          description={account.serverHost || "Not set"}
        />
      </SettingsGroup>

      <SettingsGroup title="Session">
        <SettingsRow
          label="Sign out"
          description="Signing out only affects your account. Your dictations and settings on this Mac stay."
          control={
            <Button onClick={() => setSigningOut(true)}>Sign out</Button>
          }
        />
        <SettingsRow
          label="Delete account"
          description="Deletes your Murmur account, team membership and referrals from the server. Your dictations, notes and settings on this Mac are not touched."
          control={
            <Button variant="danger" onClick={() => setDeleting(true)}>
              Delete account…
            </Button>
          }
        />
      </SettingsGroup>

      <ConfirmDialog
        open={signingOut}
        onOpenChange={setSigningOut}
        title={`Sign out of ${displayName(me)}?`}
        description="You can sign in again any time with a code sent to your email."
        confirmLabel="Sign out"
        onConfirm={async () => {
          await hub.accountSignOut();
          toast({ title: "Signed out" });
        }}
      />
      <DeleteAccountDialog
        open={deleting}
        onOpenChange={setDeleting}
        email={me.email}
      />
    </>
  );
}

/** Deleting is final: the account's email must be typed to confirm. */
function DeleteAccountDialog({
  open,
  onOpenChange,
  email,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  email: string;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) {
      setTyped("");
      setError(null);
    }
  }, [open]);
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await hub.accountDelete(typed.trim());
      onOpenChange(false);
      toast({ title: "Account deleted" });
    } catch (e) {
      setError(ipcErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        role="alertdialog"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (matches && !busy) void remove();
          }}
        >
          <DialogHeader
            title="Delete your account?"
            description="This can't be undone. Your team membership and referrals are removed from the server."
          />
          <DialogBody>
            <Field label={`Type ${email} to confirm`}>
              {({ id, describedBy }) => (
                <Input
                  ref={inputRef}
                  id={id}
                  aria-describedby={describedBy}
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                />
              )}
            </Field>
          </DialogBody>
          <DialogError message={error} />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={!matches}
              loading={busy}
            >
              Delete account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
