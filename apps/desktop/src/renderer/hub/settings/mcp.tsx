// Settings → MCP: lets AI apps on this Mac read your Notetaker meetings through a local MCP
// server. Off until turned on; read-only; meetings only. Adding Murmur to Claude Desktop or
// Cursor edits that app's config file, and only after the person has seen exactly what will be
// added and confirmed.
import { useCallback, useEffect, useState } from "react";
import { Copy, Plug, Trash2 } from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import type {
  McpAppInfo,
  McpClientInfo,
  McpConfigPreview,
  McpCopyWhat,
  McpStatus,
} from "../../../shared/mcp.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  ConfirmDialog,
  describedBy,
  Input,
  InlineAlert,
  SettingsGroup,
  SettingsRow,
  Switch,
  useToast,
} from "../ui/index.ts";
import { ipcErrorMessage } from "../model/errors.ts";
import { clientActivity, isValidPort, serverStatus } from "../model/mcp.ts";
import { StatusText, useSave, type Update } from "./common.tsx";

export function McpSection({
  settings,
  update,
}: {
  settings: Settings;
  update: Update;
}) {
  const toast = useToast();
  const save = useSave(update);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [preview, setPreview] = useState<McpConfigPreview | null>(null);
  const [revoking, setRevoking] = useState<McpClientInfo | null>(null);
  const [removing, setRemoving] = useState<McpAppInfo | null>(null);
  const [portDraft, setPortDraft] = useState(String(settings.mcp.port));
  const [name, setName] = useState("");

  const refresh = useCallback(() => {
    void hub
      .mcpStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    return hub.onMcpChanged(refresh);
  }, [refresh]);
  useEffect(
    () => refresh(),
    [settings.mcp.enabled, settings.mcp.port, refresh],
  );
  useEffect(() => setPortDraft(String(settings.mcp.port)), [settings.mcp.port]);

  const fail = (title: string, e: unknown) =>
    toast({ title, description: ipcErrorMessage(e), tone: "error" });
  const copy = async (id: string, what: McpCopyWhat, label: string) => {
    try {
      await hub.mcpCopy(id, what);
      toast({ title: `${label} copied`, tone: "success" });
    } catch (e) {
      fail("Couldn't copy", e);
    }
  };
  const openPreview = async (app: McpAppInfo) => {
    try {
      setPreview(await hub.mcpPreview(app.kind));
    } catch (e) {
      fail(`Couldn't add to ${app.label}`, e);
    }
  };
  const enabled = settings.mcp.enabled;
  const shown = status
    ? serverStatus(enabled, status.state, status.port)
    : null;
  const other = status?.clients.filter((c) => c.kind === "other") ?? [];

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Let AI apps read your meetings"
          htmlFor="mcp-enabled"
          description="Runs a server on this Mac only (127.0.0.1) while Murmur is open. Apps you connect can list, search and read your Notetaker meetings: titles, times, notes, transcripts and summaries. They can't change anything, and they never see your dictations, History, Scratchpad notes, audio, settings or keys."
          control={
            <Switch
              id="mcp-enabled"
              label="Let AI apps read your meetings"
              describedBy={describedBy("mcp-enabled")}
              checked={enabled}
              onCheckedChange={(v) => void save({ mcp: { enabled: v } })}
            />
          }
        />
        <SettingsRow
          label="Status"
          description="Nothing is reachable from the network, and every request needs an access token you created here."
          control={
            shown && (
              <StatusText tone={shown.tone} live>
                {shown.text}
              </StatusText>
            )
          }
        />
        <SettingsRow
          label="Port"
          htmlFor="mcp-port"
          description="Apps you added keep using this port, so changing it means adding them again."
          control={
            <Input
              id="mcp-port"
              aria-describedby={describedBy("mcp-port")}
              className="w-28"
              inputMode="numeric"
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={() => {
                const n = Number(portDraft);
                if (isValidPort(n) && n !== settings.mcp.port)
                  void save({ mcp: { port: n } });
                else setPortDraft(String(settings.mcp.port));
              }}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Add to an app">
        {status?.apps.map((app) => (
          <SettingsRow
            key={app.kind}
            label={app.label}
            description={
              !app.installed
                ? `${app.label} doesn't seem to be installed (its settings folder wasn't found).`
                : app.kind === "claude"
                  ? app.added
                    ? "Murmur's extension was sent to Claude. Manage it in Claude → Settings → Extensions."
                    : "Creates a Claude extension and opens it in Claude, which shows its own install screen. Claude runs it only while it is open."
                  : app.added
                    ? "Murmur is in its config. Restart the app if it was open."
                    : "Adds a Murmur entry that connects straight to the local server."
            }
            control={
              <div className="flex gap-2">
                {app.added && (
                  <Button onClick={() => setRemoving(app)}>Remove</Button>
                )}
                <Button
                  variant="outline"
                  icon={<Plug className="size-3.5" aria-hidden />}
                  disabled={!enabled || !app.installed}
                  onClick={() => void openPreview(app)}
                >
                  {app.added && app.kind === "cursor"
                    ? "Update"
                    : `Add to ${app.label.split(" ")[0]}`}
                </Button>
              </div>
            }
          />
        ))}
        <SettingsRow
          label="ChatGPT, Gemini and other cloud apps"
          description="They can only connect to a public HTTPS server, and Murmur has no hosted service yet. Needs Murmur cloud (not set up)."
        />
      </SettingsGroup>

      <SettingsGroup title="All other apps">
        <SettingsRow
          label="Connection URL"
          description="For apps that take a URL and a header “Authorization: Bearer <token>”. Create a token below."
          control={
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-surface px-2 py-1 text-ui">
                {status?.url}
              </code>
            </div>
          }
        />
        {other.map((c) => (
          <SettingsRow
            key={c.id}
            label={c.name}
            description={clientActivity(c, new Date())}
            control={
              <div className="flex gap-2">
                <Button
                  icon={<Copy className="size-3.5" aria-hidden />}
                  onClick={() => void copy(c.id, "token", "Token")}
                >
                  Token
                </Button>
                <Button onClick={() => void copy(c.id, "http", "URL config")}>
                  URL config
                </Button>
                <Button
                  onClick={() => void copy(c.id, "stdio", "Command config")}
                >
                  Command config
                </Button>
                <Button
                  variant="danger"
                  aria-label={`Revoke ${c.name}`}
                  icon={<Trash2 className="size-3.5" aria-hidden />}
                  onClick={() => setRevoking(c)}
                />
              </div>
            }
          />
        ))}
        <SettingsRow
          label="New access token"
          htmlFor="mcp-new-client"
          description="Name the app it is for. The token is copied, never shown on screen."
          control={
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void hub
                  .mcpCreateClient(name)
                  .then(() => setName(""))
                  .catch((err) => fail("Couldn't create a token", err));
              }}
            >
              <Input
                id="mcp-new-client"
                aria-describedby={describedBy("mcp-new-client")}
                className="w-44"
                value={name}
                placeholder="App name"
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" disabled={!name.trim() || !enabled}>
                Create
              </Button>
            </form>
          }
        />
      </SettingsGroup>

      {status && status.clients.some((c) => c.kind !== "other") && (
        <SettingsGroup title="Connected apps">
          {status.clients
            .filter((c) => c.kind !== "other")
            .map((c) => (
              <SettingsRow
                key={c.id}
                label={c.name}
                description={clientActivity(c, new Date())}
              />
            ))}
        </SettingsGroup>
      )}

      {!enabled && (
        <InlineAlert
          tone="warning"
          icon={<Plug className="size-4" aria-hidden />}
        >
          MCP is off. Turn it on to add apps.
        </InlineAlert>
      )}

      <ConfirmDialog
        open={preview !== null}
        onOpenChange={(o) => !o && setPreview(null)}
        title={`Add Murmur to ${preview?.label ?? ""}?`}
        description={
          preview &&
          (preview.method === "extension" ? (
            <span className="block space-y-2">
              <span className="block">
                Murmur will create a Murmur extension and open it with{" "}
                {preview.label}, which asks you to approve the install itself.
                {preview.replaces ? " " + preview.backupNote : ""} The extension
                is a small script that passes requests to this app; the access
                token is hidden here and is kept by {preview.label}. The file is
                deleted from this Mac a few minutes later.
              </span>
              <pre className="max-h-48 overflow-auto rounded-md bg-surface p-2 text-xs">
                {preview.entry}
              </pre>
            </span>
          ) : (
            <span className="block space-y-2">
              <span className="block">
                Murmur will add this entry to <code>{preview.configPath}</code>
                {preview.replaces
                  ? ", replacing its existing “murmur” entry"
                  : ""}
                . Your other servers stay as they are. {preview.backupNote} The
                access token is hidden here.
              </span>
              <pre className="max-h-48 overflow-auto rounded-md bg-surface p-2 text-xs">
                {preview.entry}
              </pre>
            </span>
          ))
        }
        confirmLabel={
          preview?.method === "extension" ? "Open in Claude" : "Add"
        }
        onConfirm={async () => {
          if (!preview) return;
          const r = await hub.mcpInstall(preview.kind);
          toast({
            title: r.opened
              ? `Opened in ${preview.label}`
              : `Added to ${preview.label}`,
            description: r.opened
              ? `Approve the install in ${preview.label}.`
              : `Restart ${preview.label} to use it.${r.backupPath ? " The old file was backed up." : ""}`,
            tone: "success",
          });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove Murmur from ${removing?.label ?? ""}?`}
        description={
          removing && (
            <span className="block space-y-2">
              <span className="block">
                Murmur's access token is revoked, so it stops working at once.
                {removing.kind === "claude"
                  ? " Murmur can't uninstall an extension: remove it in Claude → Settings → Extensions."
                  : " Murmur's entry is taken out of its config file."}
              </span>
              {removing.backupsWithEntry > 0 && (
                <span className="block">
                  {removing.backupsWithEntry} older backup cop
                  {removing.backupsWithEntry === 1 ? "y" : "ies"} Murmur made
                  still contain its entry and token. They are cleaned too: only
                  the “murmur” entry is taken out of them.
                </span>
              )}
            </span>
          )
        }
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!removing) return;
          const r = await hub.mcpRemove(removing.kind, true);
          toast({
            title: `Removed from ${removing.label}`,
            description: r.backupPath
              ? "A backup of the old file was saved next to it."
              : undefined,
            tone: "success",
          });
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke “${revoking?.name ?? ""}”?`}
        description="Its token stops working at once. An app that uses it needs a new one."
        confirmLabel="Revoke"
        destructive
        onConfirm={async () => {
          if (revoking) await hub.mcpRevokeClient(revoking.id);
        }}
      />
    </>
  );
}
