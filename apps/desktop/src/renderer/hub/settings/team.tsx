// Settings → Team (Stage B): create a team (it starts a Pro trial) or join one with an invite
// code; with a team, its members, roles and pending invites. Which actions appear follows your
// role; the server enforces the same rules.
import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import { RULES } from "@murmur/account-api";
import type { AccountStatus } from "../../../shared/account.ts";
import { hub } from "../bridge.ts";
import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  ListGroup,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  SettingsGroup,
  SettingsRow,
  useToast,
} from "../ui/index.ts";
import {
  canInvite,
  canLeave,
  canRename,
  emailsFromRows,
  inviteTokenFrom,
  memberActions,
  memberLabel,
  parseEmails,
  pendingInvites,
  ROLE_LABEL,
  sortMembers,
  trialDaysLeft,
} from "../model/account.ts";
import { Avatar } from "../account/avatar.tsx";
import { OfflineNotice } from "../account/offline.tsx";
import { AccountGate } from "../account/signed-out.tsx";
import {
  useAccount,
  useAction,
  useRefreshOnOpen,
} from "../account/use-account.ts";

export function TeamSection() {
  const account = useAccount();
  useRefreshOnOpen(account);
  return (
    <AccountGate
      account={account}
      what="Teams share a Pro trial and manage who can use it."
    >
      {(a) => (
        <>
          {a.offline && <OfflineNotice />}
          {a.me?.team ? <TeamView account={a} /> : <NoTeam />}
        </>
      )}
    </AccountGate>
  );
}

function NoTeam() {
  const toast = useToast();
  const [name, setName] = useState("");
  const [rows, setRows] = useState(["", "", ""]);
  const [token, setToken] = useState("");
  const create = useAction();
  const join = useAction();
  const parsed = emailsFromRows(rows);
  const problem = parsed.invalid.length
    ? `These don't look like email addresses: ${parsed.invalid.join(", ")}`
    : parsed.tooMany
      ? `Invite up to ${RULES.maxInvitesPerRequest} people at a time.`
      : null;
  const canCreate = name.trim().length > 0 && !problem;

  return (
    <>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!canCreate || create.busy) return;
          void create
            .run(() => hub.teamCreate(name.trim(), parsed.valid))
            .then(
              (ok) => ok && toast({ title: "Team created", tone: "success" }),
            );
        }}
      >
        <SettingsGroup
          title="Invite your team"
          description={`Creating a team starts a ${RULES.teamTrialDays}-day Pro trial for everyone in it. Each person gets a code by email and joins by entering it here, in Settings → Team. Invites are valid for ${RULES.teamInviteDays} days.`}
        >
          <div className="space-y-4 py-5">
            <Field label="Team name">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  maxLength={60}
                  autoComplete="organization"
                  placeholder="Acme writers"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-ui font-medium text-fg">
                Teammates' emails
              </legend>
              {rows.map((value, i) => (
                <Input
                  key={i}
                  type="email"
                  aria-label={`Email ${i + 1}`}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="teammate@example.com"
                  value={value}
                  onChange={(e) =>
                    setRows(rows.map((r, j) => (j === i ? e.target.value : r)))
                  }
                />
              ))}
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus className="size-3.5" aria-hidden />}
                disabled={rows.length >= RULES.maxInvitesPerRequest}
                onClick={() => setRows([...rows, ""])}
              >
                Add more
              </Button>
            </fieldset>
            {(problem || create.error) && (
              <p role="alert" className="text-caption text-danger">
                {problem ?? create.error}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                disabled={!canCreate}
                loading={create.busy}
              >
                Continue
              </Button>
            </div>
          </div>
        </SettingsGroup>
      </form>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const t = inviteTokenFrom(token);
          if (t.length < 8 || join.busy) return;
          void join
            .run(() => hub.teamJoin(t))
            .then(
              (ok) =>
                ok && toast({ title: "You joined the team", tone: "success" }),
            );
        }}
      >
        <SettingsGroup
          title="Join a team"
          description="Paste the invite code from your invitation email."
        >
          <div className="py-5">
            <Field label="Invite code" error={join.error}>
              {({ id, describedBy }) => (
                <div className="flex gap-2">
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={join.error ? true : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      join.clearError();
                    }}
                  />
                  <Button
                    type="submit"
                    disabled={inviteTokenFrom(token).length < 8}
                    loading={join.busy}
                  >
                    Join team
                  </Button>
                </div>
              )}
            </Field>
          </div>
        </SettingsGroup>
      </form>
    </>
  );
}

function TeamView({ account }: { account: AccountStatus }) {
  const toast = useToast();
  const team = account.team;
  const summary = account.me!.team!;
  const role = team?.role ?? summary.role;
  const [name, setName] = useState<string | null>(null);
  const [emails, setEmails] = useState("");
  const [removing, setRemoving] = useState<{
    userId: string;
    label: string;
  } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const rename = useAction();
  const invite = useAction();
  const act = useAction();

  const days = team ? trialDaysLeft(team.trialEndsAt, Date.now()) : null;
  const parsed = parseEmails(emails);
  const problem = parsed.invalid.length
    ? `These don't look like email addresses: ${parsed.invalid.join(", ")}`
    : parsed.tooMany
      ? `Invite up to ${RULES.maxInvitesPerRequest} people at a time.`
      : null;

  const changeRole = (userId: string, next: "admin" | "member") =>
    act.run(() => hub.teamSetRole(userId, next));

  return (
    <>
      <SettingsGroup title="Team">
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              {summary.name}
              <Badge>{ROLE_LABEL[role]}</Badge>
            </span>
          }
          description={
            account.me!.plan.source === "trial" && days !== null
              ? `Pro trial: ${days === 0 ? "ends today" : days === 1 ? "1 day left" : `${days} days left`}.`
              : `${team?.members.length ?? "—"} ${team?.members.length === 1 ? "member" : "members"}`
          }
        />
        {canRename(role) && (
          <SettingsRow
            label="Team name"
            htmlFor="team-name"
            description={rename.error ?? undefined}
            control={
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const next = (name ?? summary.name).trim();
                  if (next && next !== summary.name)
                    void rename
                      .run(() => hub.teamRename(next))
                      .then(() => setName(null));
                }}
              >
                <Input
                  id="team-name"
                  className="w-56"
                  maxLength={60}
                  value={name ?? summary.name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button
                  type="submit"
                  disabled={!name?.trim() || name.trim() === summary.name}
                  loading={rename.busy}
                >
                  Rename
                </Button>
              </form>
            }
          />
        )}
      </SettingsGroup>

      {act.error && (
        <p role="alert" className="text-ui text-danger">
          {act.error}
        </p>
      )}

      <section className="space-y-2" aria-labelledby="team-members">
        <h3
          id="team-members"
          className="px-0.5 pt-2 text-ui font-semibold text-fg"
        >
          Members
        </h3>
        {team ? (
          <ListGroup label="Members">
            {sortMembers(team.members).map((m) => {
              const isSelf = m.userId === account.me!.id;
              const actions = memberActions(role, { role: m.role, isSelf });
              return (
                <li
                  key={m.userId}
                  className="flex min-h-[53px] items-center gap-3 py-2 pl-4 pr-3"
                >
                  <Avatar
                    me={{
                      firstName: memberLabel(m),
                      lastName: "",
                      email: m.email,
                      avatar: null,
                    }}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ui text-fg">
                      {memberLabel(m)}
                      {isSelf && (
                        <span className="text-fg-secondary"> (you)</span>
                      )}
                    </div>
                    <div className="truncate text-caption text-fg-secondary">
                      {m.email}
                    </div>
                  </div>
                  <Badge tone={m.role === "owner" ? "accent" : "neutral"}>
                    {ROLE_LABEL[m.role]}
                  </Badge>
                  {(actions.setRole || actions.remove) && (
                    <Menu>
                      <MenuTrigger asChild>
                        <IconButton
                          size="sm"
                          label={`Actions for ${memberLabel(m)}`}
                          icon={
                            <MoreHorizontal className="size-4" aria-hidden />
                          }
                        />
                      </MenuTrigger>
                      <MenuContent>
                        {actions.setRole && (
                          <MenuItem
                            onSelect={() =>
                              void changeRole(m.userId, actions.setRole!)
                            }
                          >
                            Make {actions.setRole}
                          </MenuItem>
                        )}
                        {actions.setRole && actions.remove && <MenuSeparator />}
                        {actions.remove && (
                          <MenuItem
                            destructive
                            onSelect={() =>
                              setRemoving({
                                userId: m.userId,
                                label: memberLabel(m),
                              })
                            }
                          >
                            Remove from team…
                          </MenuItem>
                        )}
                      </MenuContent>
                    </Menu>
                  )}
                </li>
              );
            })}
          </ListGroup>
        ) : (
          <p className="text-ui text-fg-secondary">Loading members…</p>
        )}
      </section>

      {team && canInvite(role) && (
        <>
          {pendingInvites(team).length > 0 && (
            <section className="space-y-2" aria-labelledby="team-invites">
              <h3
                id="team-invites"
                className="px-0.5 pt-2 text-ui font-semibold text-fg"
              >
                Pending invites
              </h3>
              <ListGroup label="Pending invites">
                {pendingInvites(team).map((i) => (
                  <li
                    key={i.id}
                    className="flex min-h-[53px] items-center gap-3 py-2 pl-4 pr-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui text-fg">{i.email}</div>
                      <div className="text-caption text-fg-secondary">
                        Expires {new Date(i.expiresAt).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() =>
                        void act.run(() => hub.teamRevokeInvite(i.id))
                      }
                      aria-label={`Revoke the invite for ${i.email}`}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ListGroup>
            </section>
          )}
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!parsed.valid.length || problem || invite.busy) return;
              void invite
                .run(() => hub.teamInvite(parsed.valid))
                .then((ok) => {
                  if (!ok) return;
                  setEmails("");
                  toast({ title: "Invites sent", tone: "success" });
                });
            }}
          >
            <SettingsGroup
              title="Invite more people"
              description="Each person gets a code by email and joins by entering it in Murmur, under Settings → Team."
            >
              <div className="py-5">
                <Field
                  label="Email addresses"
                  hint="Separate addresses with commas or spaces."
                  error={problem ?? invite.error}
                >
                  {({ id, describedBy }) => (
                    <div className="flex gap-2">
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        aria-invalid={
                          problem || invite.error ? true : undefined
                        }
                        inputMode="email"
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="teammate@example.com"
                        value={emails}
                        onChange={(e) => {
                          setEmails(e.target.value);
                          invite.clearError();
                        }}
                      />
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={!parsed.valid.length || Boolean(problem)}
                        loading={invite.busy}
                      >
                        Send invites
                      </Button>
                    </div>
                  )}
                </Field>
              </div>
            </SettingsGroup>
          </form>
        </>
      )}

      <SettingsGroup>
        <SettingsRow
          label="Leave team"
          description={
            canLeave(role)
              ? "You'll lose the team's Pro plan. Your dictations on this Mac are not affected."
              : "The owner can't leave the team."
          }
          control={
            <Button
              variant="danger"
              disabled={!canLeave(role)}
              onClick={() => setLeaving(true)}
            >
              Leave team…
            </Button>
          }
        />
      </SettingsGroup>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.label ?? ""} from the team?`}
        description="They lose the team's Pro plan. They can be invited again."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (removing) await hub.teamRemoveMember(removing.userId);
        }}
      />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${summary.name}?`}
        description="You'll lose the team's Pro plan unless you have your own."
        confirmLabel="Leave team"
        destructive
        onConfirm={async () => {
          await hub.teamLeave();
          toast({ title: "You left the team" });
        }}
      />
    </>
  );
}
