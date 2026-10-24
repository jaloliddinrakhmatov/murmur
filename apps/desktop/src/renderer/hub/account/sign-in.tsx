// Sign in with an emailed code (no password): email first, then the 6-digit code. Pasting the
// code works with spaces or dashes; a full code is submitted at once. Nothing is sent until the
// person presses Send code.
import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
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
  useToast,
} from "../ui/index.ts";
import {
  isCompleteCode,
  isEmail,
  NEWEST_CODE_NOTE,
  codeSentCopy,
  normalizeCode,
  resendWait,
} from "../model/account.ts";
import { displayName } from "../model/account.ts";
import { useAction, useNow } from "./use-account.ts";

export function SignInDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentAt, setSentAt] = useState(0);
  const [devOutbox, setDevOutbox] = useState(false);
  const [delivery, setDelivery] = useState<"email" | "outbox">("email");
  const [devCode, setDevCode] = useState<string | null>(null);
  const send = useAction();
  const verify = useAction();
  const emailRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const now = useNow(open && step === "code");
  const wait = resendWait(sentAt, now);

  useEffect(() => {
    if (open) return;
    setStep("email");
    setCode("");
    setDevOutbox(false);
    setDevCode(null);
    send.clearError();
    verify.clearError();
  }, [open]);

  const sendCode = async () => {
    const address = email.trim();
    const res = await send.run(() => hub.accountStartSignIn(address));
    if (!res) return;
    setEmail(address.toLowerCase());
    setSentAt(Date.now());
    setDevOutbox(res.devOutbox);
    setDelivery(res.delivery);
    setDevCode(res.devCode);
    setCode("");
    verify.clearError();
    setStep("code");
    setTimeout(() => codeRef.current?.focus(), 0);
  };

  const submitCode = async (value: string) => {
    if (!isCompleteCode(value) || verify.busy) return;
    const status = await verify.run(() => hub.accountVerify(email, value));
    if (!status) {
      setCode("");
      codeRef.current?.focus();
      return;
    }
    onOpenChange(false);
    toast({
      title: "Signed in",
      description: status.me ? displayName(status.me) : undefined,
      tone: "success",
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !verify.busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (step === "email" ? emailRef : codeRef).current?.focus();
        }}
      >
        {step === "email" ? (
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              if (isEmail(email) && !send.busy) void sendCode();
            }}
          >
            <DialogHeader
              title="Sign in to Murmur"
              description="We'll email you a 6-digit code. There's no password."
            />
            <DialogBody>
              <Field label="Email">
                {({ id, describedBy }) => (
                  <Input
                    ref={emailRef}
                    id={id}
                    aria-describedby={describedBy}
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    spellCheck={false}
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      send.clearError();
                    }}
                  />
                )}
              </Field>
              <p className="mt-3 text-caption text-fg-secondary">
                Signing in is optional. Dictation, History and your notes stay
                on this Mac either way.
              </p>
            </DialogBody>
            <DialogError message={send.error} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!isEmail(email)}
                loading={send.busy}
              >
                Send code
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode(code);
            }}
          >
            <DialogHeader
              title="Enter your code"
              description={(() => {
                const copy = codeSentCopy(delivery, email);
                return (
                  <>
                    {copy.before}
                    {copy.email && (
                      <span className="font-medium text-fg">{copy.email}</span>
                    )}
                    {copy.after}
                  </>
                );
              })()}
            />
            <DialogBody>
              <Field label="6-digit code" error={verify.error}>
                {({ id, describedBy }) => (
                  <Input
                    ref={codeRef}
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={verify.error ? true : undefined}
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    spellCheck={false}
                    placeholder="123456"
                    className="h-12 text-center font-mono text-heading tracking-[0.4em]"
                    value={code}
                    disabled={verify.busy}
                    onChange={(e) => {
                      const next = normalizeCode(e.target.value);
                      setCode(next);
                      verify.clearError();
                      if (isCompleteCode(next)) void submitCode(next);
                    }}
                  />
                )}
              </Field>
              <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={wait > 0 || send.busy || verify.busy}
                  loading={send.busy}
                  onClick={() => void sendCode()}
                >
                  {wait > 0
                    ? `Send a new code in ${wait} s`
                    : "Send a new code"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={verify.busy}
                  onClick={() => {
                    setStep("email");
                    setTimeout(() => emailRef.current?.focus(), 0);
                  }}
                >
                  Use a different email
                </Button>
              </div>
              <p className="mt-2 text-caption text-fg-secondary">
                {NEWEST_CODE_NOTE}
              </p>
              {send.error && (
                <p role="alert" className="mt-2 text-caption text-danger">
                  {send.error}
                </p>
              )}
              {devOutbox && (
                <div className="mt-4 rounded-md bg-warning-soft px-3 py-2.5">
                  <p className="text-caption text-fg">
                    Development server: emails are not sent.
                  </p>
                  {devCode && (
                    <div className="mt-2 flex items-center gap-3">
                      <span className="font-mono text-body tracking-[0.3em]">
                        {devCode}
                      </span>
                      <Button
                        size="sm"
                        disabled={verify.busy}
                        onClick={() => {
                          setCode(devCode);
                          verify.clearError();
                          codeRef.current?.focus();
                        }}
                      >
                        Use this code
                      </Button>
                    </div>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-1 -ml-2"
                    icon={<ExternalLink className="size-3.5" aria-hidden />}
                    onClick={() => void hub.accountOpenOutbox().catch(() => {})}
                  >
                    Open test outbox
                  </Button>
                </div>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                onClick={() => onOpenChange(false)}
                disabled={verify.busy}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={!isCompleteCode(code)}
                loading={verify.busy}
              >
                Sign in
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
