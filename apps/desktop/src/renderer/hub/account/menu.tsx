// The avatar button in the title bar and its menu: who you are, the referral offer, your
// account settings, and signing in or out.
import { useRef } from "react";
import { Gift, LogIn, LogOut, Settings2 } from "lucide-react";
import { hub } from "../bridge.ts";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
  useToast,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { displayName } from "../model/account.ts";
import { Avatar } from "./avatar.tsx";
import { useAccount } from "./use-account.ts";
import { useAccountUi } from "./ui.tsx";

export function AccountMenu({
  navigate,
}: {
  navigate: (route: string) => void;
}) {
  const account = useAccount();
  const ui = useAccountUi();
  const toast = useToast();
  // An item that opens a dialog keeps focus there instead of returning it to the avatar button.
  const opening = useRef(false);
  const open = (fn: () => void) => () => {
    opening.current = true;
    fn();
  };
  const me = account?.me ?? null;
  const signedIn = account?.phase === "signed-in";
  const label = me
    ? `Account: ${displayName(me)}`
    : signedIn
      ? "Account: signed in"
      : account?.phase === "restoring"
        ? "Account: checking your sign-in"
        : "Account: signed out";

  const signOut = async () => {
    try {
      await hub.accountSignOut();
      toast({ title: "Signed out" });
    } catch (e) {
      toast({
        title: "Couldn't sign out",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  return (
    <Menu modal={false}>
      <Tooltip content={label} side="bottom">
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="no-drag flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--m-duration-fast)] hover:bg-surface-hover"
          >
            <Avatar me={me} />
          </button>
        </MenuTrigger>
      </Tooltip>
      <MenuContent
        className="w-72"
        onCloseAutoFocus={(e) => {
          if (opening.current) e.preventDefault();
          opening.current = false;
        }}
      >
        {signedIn ? (
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="truncate text-ui font-medium text-fg">
              {me ? displayName(me) : "Signed in"}
            </div>
            {me && (
              <div className="truncate text-caption text-fg-secondary">
                {me.email}
              </div>
            )}
            {account?.offline && (
              <div className="mt-1 text-caption text-warning">
                Can't reach Murmur's server
              </div>
            )}
          </div>
        ) : (
          <div className="px-2.5 pb-2 pt-1.5 text-caption text-fg-secondary">
            {account?.phase === "restoring"
              ? "Checking your sign-in…"
              : "You're not signed in. Murmur works fully without an account."}
          </div>
        )}
        <MenuSeparator />
        {signedIn ? (
          <>
            <MenuItem
              icon={<Gift className="size-4" />}
              className="h-auto py-1.5"
              onSelect={open(ui.refer)}
            >
              <span className="flex flex-col leading-tight">
                <span>Get a free month of Murmur Pro</span>
                <span className="text-caption text-fg-secondary">
                  Refer a friend
                </span>
              </span>
            </MenuItem>
            <MenuItem
              icon={<Settings2 className="size-4" />}
              onSelect={() => navigate("settings/account")}
            >
              Manage account
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<LogOut className="size-4" />}
              onSelect={() => void signOut()}
            >
              Sign out
            </MenuItem>
          </>
        ) : (
          <MenuItem
            icon={<LogIn className="size-4" />}
            disabled={account?.phase === "restoring"}
            onSelect={open(ui.signIn)}
          >
            Sign in
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}
