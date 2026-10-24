// The Hub's account channels (Stage B). Only the Hub page may call them; every input is checked
// here with zod and again by AccountService against the shared contract. Files and the browser
// are opened from this side: the window never reads a picture or an address it can't see.
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  type NativeImage,
} from "electron";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { BILLING_INTERVALS } from "@murmur/account-api";
import type { CheckoutResult } from "../../shared/account.ts";
import type { AccountService } from "../account/service.ts";
import { AccountError } from "../account/errors.ts";
import { fitAvatar, type AvatarImage } from "../account/avatar.ts";
import { fromHub } from "./hub.ts";

const MAX_PICTURE_BYTES = 25_000_000;

const Email = z.string().max(254);
const Emails = z.array(Email).max(50);
const Interval = z.enum(BILLING_INTERVALS);

const wrap = (img: NativeImage): AvatarImage => ({
  isEmpty: () => img.isEmpty(),
  square: () => {
    const { width, height } = img.getSize();
    const side = Math.min(width, height);
    return wrap(
      img.crop({
        x: Math.floor((width - side) / 2),
        y: Math.floor((height - side) / 2),
        width: side,
        height: side,
      }),
    );
  },
  scaled: (side) =>
    wrap(img.resize({ width: side, height: side, quality: "best" })),
  size: () => img.getSize().width,
  png: () => img.toPNG(),
  jpeg: (quality) => img.toJPEG(quality),
});

export function registerAccountIpc(
  account: AccountService,
  /** Keep or start fresh after another account signs in; deleting data is the Hub's job. */
  resolveSwitch: (choice: "keep" | "fresh") => Promise<void>,
): void {
  const handle = <S extends z.ZodType>(
    channel: string,
    schema: S | null,
    fn: (input: z.output<S>, e: Electron.IpcMainInvokeEvent) => unknown,
  ) =>
    ipcMain.handle(channel, (e, input: unknown) => {
      if (!fromHub(e)) throw new Error("not allowed");
      const parsed = schema
        ? schema.safeParse(input)
        : { success: true as const, data: undefined };
      if (!parsed.success)
        throw new AccountError(
          "invalid-input",
          "That isn't valid. Check it and try again.",
        );
      return fn(parsed.data as z.output<S>, e);
    });

  handle("hub:accountStatus", null, () => account.snapshot());
  handle("hub:accountRefresh", null, () => account.refresh());
  handle(
    "hub:accountStartSignIn",
    z.object({ email: Email }),
    async ({ email }) => {
      const start = await account.startSignIn({ email });
      // The test mailbox is looked for only now: the person has asked for a code. Servers that
      // don't say how the code was delivered are judged by whether they have a test mailbox.
      const hasOutbox = (await account.devOutboxUrl()) !== null;
      const delivery =
        start.delivery ??
        (hasOutbox ? ("outbox" as const) : ("email" as const));
      return {
        expiresInSec: start.expiresInSec,
        delivery,
        devOutbox: delivery === "outbox" && hasOutbox,
        devCode:
          delivery === "outbox" && hasOutbox
            ? await account.devOutboxCode(email)
            : null,
      };
    },
  );
  handle(
    "hub:accountVerify",
    z.object({ email: Email, code: z.string().max(12) }),
    (input) => account.verify(input),
  );
  handle("hub:accountSignOut", null, () => account.signOut());
  handle(
    "hub:accountUpdateProfile",
    z.object({ firstName: z.string().max(200), lastName: z.string().max(200) }),
    (input) => account.updateProfile(input),
  );
  handle("hub:accountPickAvatar", null, async (_i, e) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a profile picture",
      properties: ["openFile"],
      filters: [{ name: "Pictures", extensions: ["png", "jpg", "jpeg"] }],
    };
    const r = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const file = r.filePaths[0];
    if (r.canceled || !file) return { changed: false };
    if ((await stat(file)).size > MAX_PICTURE_BYTES)
      throw new AccountError(
        "invalid-input",
        "That picture is too large to use. Choose a smaller one.",
      );
    const dataUrl = fitAvatar(
      wrap(nativeImage.createFromBuffer(await readFile(file))),
    );
    await account.setAvatar(dataUrl);
    return { changed: true };
  });
  handle("hub:accountRemoveAvatar", null, () => account.removeAvatar());
  handle("hub:accountDelete", z.object({ confirmEmail: Email }), (input) =>
    account.deleteAccount(input),
  );
  handle(
    "hub:accountResolveSwitch",
    z.object({ choice: z.enum(["keep", "fresh"]) }),
    async ({ choice }) => {
      await resolveSwitch(choice);
      return account.snapshot();
    },
  );
  handle("hub:accountOpenOutbox", null, async () => {
    const url = await account.devOutboxUrl();
    if (!url)
      throw new AccountError("not-found", "This server has no test mailbox.");
    await shell.openExternal(url);
  });

  handle(
    "hub:teamCreate",
    z.object({ name: z.string().max(200), invites: Emails }),
    (input) => account.createTeam(input),
  );
  handle("hub:teamInvite", z.object({ emails: Emails }), (input) =>
    account.inviteToTeam(input),
  );
  handle(
    "hub:teamRevokeInvite",
    z.object({ inviteId: z.string().min(1).max(100) }),
    ({ inviteId }) => account.revokeInvite(inviteId),
  );
  handle("hub:teamJoin", z.object({ token: z.string().max(200) }), (input) =>
    account.joinTeam(input),
  );
  handle(
    "hub:teamSetRole",
    z.object({
      userId: z.string().min(1).max(100),
      role: z.enum(["admin", "member"]),
    }),
    ({ userId, role }) => account.setMemberRole(userId, { role }),
  );
  handle(
    "hub:teamRemoveMember",
    z.object({ userId: z.string().min(1).max(100) }),
    ({ userId }) => account.removeMember(userId),
  );
  handle("hub:teamLeave", null, () => account.leaveTeam());
  handle("hub:teamRename", z.object({ name: z.string().max(200) }), (input) =>
    account.renameTeam(input),
  );

  handle("hub:referralInvite", z.object({ emails: Emails }), (input) =>
    account.inviteFriends(input),
  );
  handle("hub:referralApply", z.object({ code: z.string().max(40) }), (input) =>
    account.applyReferral(input),
  );

  handle("hub:billingPlans", z.object({ interval: Interval }), ({ interval }) =>
    account.plans(interval),
  );
  handle(
    "hub:billingCheckout",
    z.object({ plan: z.enum(["pro", "enterprise"]), interval: Interval }),
    async (input): Promise<CheckoutResult> => {
      const res = await account.checkout(input);
      if (res.kind === "activated") return { kind: "activated" };
      if (res.kind === "contact") return { kind: "contact", email: res.email };
      // A payment page opens in the browser, and only over https.
      if (new URL(res.url).protocol !== "https:")
        throw new AccountError(
          "invalid-response",
          "Murmur's server sent an address it can't open safely.",
        );
      await shell.openExternal(res.url);
      return { kind: "redirect" };
    },
  );
  handle("hub:billingCancel", null, () => account.cancelSubscription());
  handle("hub:billingPromo", z.object({ code: z.string().max(60) }), (input) =>
    account.applyPromo(input),
  );
}
