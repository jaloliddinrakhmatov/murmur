// The account half of the Hub's window.hub (Stage B); see AccountApi in shared/account.ts.
import { ipcRenderer } from "electron";
import type { AccountApi } from "../shared/account.ts";

const invoke = (channel: string, input?: unknown) =>
  ipcRenderer.invoke(channel, input);

export const accountBridge: AccountApi = {
  accountStatus: () => invoke("hub:accountStatus"),
  accountRefresh: () => invoke("hub:accountRefresh"),
  onAccountChanged: (cb) => {
    const listener = (_e: unknown, status: Parameters<typeof cb>[0]) =>
      cb(status);
    ipcRenderer.on("hub:accountChanged", listener);
    return () => ipcRenderer.removeListener("hub:accountChanged", listener);
  },
  accountStartSignIn: (email) => invoke("hub:accountStartSignIn", { email }),
  accountVerify: (email, code) => invoke("hub:accountVerify", { email, code }),
  accountSignOut: () => invoke("hub:accountSignOut"),
  accountUpdateProfile: (names) => invoke("hub:accountUpdateProfile", names),
  accountPickAvatar: () => invoke("hub:accountPickAvatar"),
  accountRemoveAvatar: () => invoke("hub:accountRemoveAvatar"),
  accountDelete: (confirmEmail) =>
    invoke("hub:accountDelete", { confirmEmail }),
  accountResolveSwitch: (choice) =>
    invoke("hub:accountResolveSwitch", { choice }),
  accountOpenOutbox: () => invoke("hub:accountOpenOutbox"),
  teamCreate: (name, invites) => invoke("hub:teamCreate", { name, invites }),
  teamInvite: (emails) => invoke("hub:teamInvite", { emails }),
  teamRevokeInvite: (inviteId) => invoke("hub:teamRevokeInvite", { inviteId }),
  teamJoin: (token) => invoke("hub:teamJoin", { token }),
  teamSetRole: (userId, role) => invoke("hub:teamSetRole", { userId, role }),
  teamRemoveMember: (userId) => invoke("hub:teamRemoveMember", { userId }),
  teamLeave: () => invoke("hub:teamLeave"),
  teamRename: (name) => invoke("hub:teamRename", { name }),
  referralInvite: (emails) => invoke("hub:referralInvite", { emails }),
  referralApply: (code) => invoke("hub:referralApply", { code }),
  billingPlans: (interval) => invoke("hub:billingPlans", { interval }),
  billingCheckout: (plan, interval) =>
    invoke("hub:billingCheckout", { plan, interval }),
  billingCancel: () => invoke("hub:billingCancel"),
  billingPromo: (code) => invoke("hub:billingPromo", { code }),
};
