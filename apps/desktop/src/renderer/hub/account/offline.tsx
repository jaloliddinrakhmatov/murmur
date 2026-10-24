import { CloudOff } from "lucide-react";
import { Button, InlineAlert } from "../ui/index.ts";
import { refreshAccount } from "./use-account.ts";

export const OFFLINE_TEXT = "Can't reach Murmur's server";

/** Shown on a signed-in screen when the last request failed; the data below is the last we had. */
export function OfflineNotice() {
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
      {OFFLINE_TEXT}. What you see may be out of date; everything on this Mac
      keeps working.
    </InlineAlert>
  );
}
