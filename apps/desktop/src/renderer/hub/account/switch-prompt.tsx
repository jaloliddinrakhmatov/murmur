// "Keep this Mac's Murmur data?": shown when an account other than the one this Mac's data was
// last used with signs in. Keep hands the data to the new account; Start fresh deletes it after a
// second confirmation (with a chance to export first). Closing decides nothing: it asks again at
// the next start. Nothing here leaves the Mac either way.
import { useEffect, useRef, useState } from "react";
import { hub } from "../bridge.ts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogError,
  DialogFooter,
  DialogHeader,
  useToast,
} from "../ui/index.ts";
import { localDataSummary } from "../model/account.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { useAccount, useAction } from "./use-account.ts";

export function AccountSwitchDialog() {
  const account = useAccount();
  const toast = useToast();
  const prompt = account?.switchPrompt ?? null;
  const me = account?.me ?? null;
  const [later, setLater] = useState<string | null>(null);
  const [step, setStep] = useState<"ask" | "confirm">("ask");
  const { busy, error, run, clearError } = useAction();
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!prompt) setStep("ask");
  }, [prompt]);
  useEffect(() => {
    if (step === "confirm") backRef.current?.focus();
  }, [step]);

  const open = Boolean(prompt && me && later !== me.id);
  if (!prompt || !me) return null;
  const summary = localDataSummary(prompt.counts);

  const choose = async (choice: "keep" | "fresh") => {
    const done = await run(() => hub.accountResolveSwitch(choice));
    if (done && choice === "fresh")
      toast({
        title: "Started fresh",
        description: `Murmur's data on this Mac now belongs to ${me.email}.`,
        tone: "success",
      });
  };

  const exportCopy = async () => {
    try {
      const r = await hub.exportData();
      if (r.saved)
        toast({ title: "Exported", description: r.path, tone: "success" });
    } catch (e) {
      toast({
        title: "Export failed",
        description: ipcErrorMessage(e),
        tone: "error",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || busy) return;
        clearError();
        setStep("ask");
        setLater(me.id);
      }}
    >
      <DialogContent size="md">
        {step === "ask" ? (
          <>
            <DialogHeader
              title="Keep this Mac's Murmur data?"
              onCloseLabel="Decide later"
              description={
                prompt.previousEmail
                  ? `You're signed in as ${me.email}. This Mac has Murmur data from ${prompt.previousEmail}: ${summary}.`
                  : `You're signed in as ${me.email}. This Mac already has Murmur data: ${summary}.`
              }
            />
            <DialogBody>
              <p className="text-ui text-fg-secondary">
                Either way, it stays on this Mac. Murmur never uploads your
                History, notes or dictionary.
              </p>
            </DialogBody>
            <DialogError message={error} />
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  clearError();
                  setStep("confirm");
                }}
              >
                Start fresh…
              </Button>
              <Button
                variant="primary"
                loading={busy}
                onClick={() => void choose("keep")}
              >
                Keep it
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader
              title="Start fresh?"
              onCloseLabel="Decide later"
              description={`This deletes ${summary} from this Mac, with their saved recordings. It can't be undone.`}
            />
            <DialogBody>
              <p className="text-ui text-fg-secondary">
                Your settings, API keys and shortcuts stay. To keep a copy,
                export it first.
              </p>
            </DialogBody>
            <DialogError message={error} />
            <DialogFooter
              start={
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void exportCopy()}
                >
                  Export a copy…
                </Button>
              }
            >
              <Button
                ref={backRef}
                disabled={busy}
                onClick={() => {
                  clearError();
                  setStep("ask");
                }}
              >
                Back
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() => void choose("fresh")}
              >
                Delete and start fresh
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
