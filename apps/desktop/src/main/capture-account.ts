// Stage B screens for the capture and the accessibility audit: signed out, the real sign-in flow
// (email, code), signed in with a profile, a team with members and invites, plans, the referral
// dialog's three tabs, the avatar menu and the delete-account dialog. Everything runs through the
// real AccountService against an in-memory server with throwaway data; no network is used.
import type { BrowserWindow, WebContents } from "electron";
import type { MurmurApp } from "./app.ts";
import type { FakeMurmurServer } from "./account/fake-server.ts";
import { uiDriver } from "./ui-driver.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Show = (route: string) => Promise<BrowserWindow>;
type Shoot = (name: string, win: BrowserWindow) => Promise<void>;
type Audit = (name: string, wc: WebContents) => Promise<void>;

const EMAIL = "sample.person@example.com";

export async function captureAccountScreens(
  m: MurmurApp,
  show: Show,
  shoot: Shoot,
  audit: Audit,
  theme: string,
  server: FakeMurmurServer,
): Promise<void> {
  server.reset();
  await m.account.signOut();
  const both = async (name: string, win: BrowserWindow) => {
    await shoot(`${name}-${theme}`, win);
    await audit(`${name}-${theme}`, win.webContents);
  };
  const dialogs = (win: BrowserWindow) =>
    win.webContents.executeJavaScript(
      `document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length`,
    ) as Promise<number>;
  const openMenu = async (win: BrowserWindow) => {
    await win.webContents.executeJavaScript(
      `document.querySelector('button[aria-label^="Account"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))`,
    );
    await uiDriver(win).waitFor(`document.querySelector('[role="menu"]')`);
    await sleep(300);
  };

  // Signed out: every account screen invites sign-in and does nothing else.
  for (const section of ["account", "team", "billing"]) {
    const win = await show(`settings/${section}`);
    await both(`account-${section}-signed-out`, win);
  }
  let win = await show("home");
  await openMenu(win);
  await both("account-menu-signed-out", win);
  await uiDriver(win).key("Escape");

  // The real sign-in: email, then the code.
  win = await show("settings/account");
  let d = uiDriver(win);
  await d.clickText("Sign in");
  await d.waitFor(`document.querySelector('input[type="email"]')`);
  await d.click('input[type="email"]');
  await d.js(`document.querySelector('input[type="email"]').select()`);
  await d.type(EMAIL);
  await both("account-sign-in-email", win);
  await d.clickText("Send code");
  await d.waitFor(
    `document.querySelector('input[autocomplete="one-time-code"]')`,
  );
  await sleep(300);
  await both("account-sign-in-code", win);
  await d.click('input[autocomplete="one-time-code"]');
  await d.type("123456");
  await d.waitFor(
    `document.querySelector('[role="dialog"] input[type="email"]') === null`,
    5000,
  );
  await sleep(500);

  // Signed in: a profile, referrals, then a team.
  await m.account.updateProfile({ firstName: "Sam", lastName: "Rivera" });
  server.addReferral("Jordan", "rewarded", 2400);
  server.addReferral("Riley", "qualified", 2000);
  server.addReferral("a***@example.com", "signed-up", 640);
  win = await show("settings/account");
  await sleep(600);
  await both("account-account-signed-in", win);
  win = await show("settings/team");
  await sleep(600);
  await both("account-team-none", win);
  await m.account.createTeam({
    name: "Sample team",
    invites: ["first.invite@example.com", "second.invite@example.com"],
  });
  server.addMember("alex.morgan@example.com", "Alex Morgan", "admin");
  server.addMember("casey.lee@example.com", "Casey Lee");
  await m.account.refresh();
  win = await show("settings/team");
  await sleep(600);
  await both("account-team-owner", win);
  win = await show("settings/billing");
  await sleep(900);
  await both("account-billing", win);

  // The referral dialog, opened from the sidebar like a person would.
  win = await show("home");
  d = uiDriver(win);
  await d.clickText("Get a free month");
  await d.waitFor(`document.querySelector('[role="dialog"]')`);
  await sleep(500);
  await both("account-refer", win);
  for (const [tab, name] of [
    ["Past referrals (3)", "past"],
    ["Apply referral", "apply"],
  ] as const) {
    await d.clickText(tab);
    await sleep(400);
    await both(`account-refer-${name}`, win);
  }
  await d.key("Escape");
  await sleep(300);

  // The avatar menu, then the delete dialog.
  await openMenu(win);
  await both("account-menu-signed-in", win);
  await d.key("Escape");
  win = await show("settings/account");
  d = uiDriver(win);
  await d.clickText("Delete account…");
  await d.waitFor(`document.querySelector('[role="alertdialog"]')`);
  await sleep(300);
  await both("account-delete", win);
  await d.key("Escape");
  await sleep(300);
  if ((await dialogs(win)) > 1) await d.key("Escape");

  // Offline: the cached screens stay and say so.
  server.offline = true;
  await m.account.refresh();
  win = await show("settings/billing");
  await sleep(600);
  await both("account-billing-offline", win);
  server.offline = false;
  await m.account.signOut();
  await show("home");
}
