// Account dialogs that several places open (the avatar menu, the sidebar, Settings): sign in and
// refer a friend, and the keep-or-start-fresh question after another account signs in. They are opened through this small store and rendered once, by AccountDialogs.
import { useSyncExternalStore } from "react";
import { SignInDialog } from "./sign-in.tsx";
import { ReferDialog } from "./refer.tsx";
import { AccountSwitchDialog } from "./switch-prompt.tsx";

interface Open {
  signIn: boolean;
  refer: boolean;
}

let state: Open = { signIn: false, refer: false };
const listeners = new Set<() => void>();

function set(next: Partial<Open>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export const openSignIn = () => set({ signIn: true });
export const openRefer = () => set({ refer: true });

export function useAccountUi() {
  return { signIn: openSignIn, refer: openRefer };
}

function useOpen(): Open {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Renders the account dialogs; mounted once, inside the toast provider. */
export function AccountDialogs() {
  const open = useOpen();
  return (
    <>
      <SignInDialog
        open={open.signIn}
        onOpenChange={(signIn) => set({ signIn })}
      />
      <ReferDialog
        open={open.refer}
        onOpenChange={(refer) => set({ refer })}
        onSignIn={() => set({ refer: false, signIn: true })}
      />
      <AccountSwitchDialog />
    </>
  );
}
