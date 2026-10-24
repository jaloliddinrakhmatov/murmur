// What an account screen shows without a session: an invitation to sign in, or why that isn't
// possible, or that a saved sign-in is being checked. Nothing here pretends the screen works.
import type { ReactNode } from "react";
import { CloudOff, KeyRound } from "lucide-react";
import type { AccountStatus } from "../../../shared/account.ts";
import { Button, EmptyState, InlineAlert, Skeleton } from "../ui/index.ts";
import { OFFLINE_TEXT } from "./offline.tsx";
import { refreshAccount } from "./use-account.ts";
import { useAccountUi } from "./ui.tsx";

export function AccountGate({
  account,
  what,
  children,
}: {
  account: AccountStatus | null;
  /** What signing in unlocks here, in a sentence. */
  what: string;
  children: (a: AccountStatus) => ReactNode;
}) {
  const ui = useAccountUi();
  if (!account)
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
      </div>
    );
  if (account.phase === "restoring")
    return (
      <p role="status" className="py-10 text-center text-ui text-fg-secondary">
        Checking your sign-in…
      </p>
    );
  if (account.phase === "signed-out")
    return (
      <div className="space-y-4">
        {account.notice && (
          <InlineAlert tone="warning" icon={<KeyRound />}>
            {account.notice}
          </InlineAlert>
        )}
        <EmptyState
          title="Sign in to Murmur"
          description={`${what} Dictation, History and your notes stay on this Mac whether or not you sign in.`}
          action={
            <Button variant="primary" onClick={ui.signIn}>
              Sign in
            </Button>
          }
        />
        {account.keychain === "unavailable" && (
          <InlineAlert tone="warning" icon={<KeyRound />}>
            Murmur can't use the macOS Keychain, which it needs to keep you
            signed in. Allow access in Settings → Data and Privacy first.
          </InlineAlert>
        )}
      </div>
    );
  if (account.offline && !account.me)
    return (
      <InlineAlert
        tone="danger"
        icon={<CloudOff />}
        action={
          <Button size="sm" onClick={() => void refreshAccount()}>
            Try again
          </Button>
        }
      >
        {OFFLINE_TEXT}. Everything on this Mac keeps working.
      </InlineAlert>
    );
  return <>{children(account)}</>;
}
