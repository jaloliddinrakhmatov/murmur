// Settings → Vibe coding. Two opt-in helpers for AI chats in VS Code, Cursor and Windsurf. "Set
// up" explains what is read and turns the helper on; nothing is installed in the editor.
import type { Settings } from "../../../shared/settings.ts";
import type { StatusInfo } from "../../../shared/ipc.ts";
import { hub } from "../bridge.ts";
import {
  Button,
  describedBy,
  SettingsGroup,
  SettingsRow,
  Switch,
} from "../ui/index.ts";
import { StatusText, useSave, type Update } from "./common.tsx";

export function VibeCodingSection({
  settings,
  update,
  status,
  refresh,
}: {
  settings: Settings;
  update: Update;
  status: StatusInfo | null;
  refresh: () => void;
}) {
  const save = useSave(update);
  const v = settings.vibeCoding;
  const accessibility = status?.permissions.accessibility ?? false;
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Variable recognition (VS Code, Cursor, Windsurf)"
          htmlFor="vibe-variables"
          description="While you dictate in one of these editors, Murmur reads a little code around your cursor (never a password field) to find names like userName or get_user_by_id. They are sent to your transcription service as spelling hints for that dictation, and spoken names such as “user name” are written as the matching name from your code. Only while you dictate; nothing it reads is saved or logged. Ordinary words are left alone unless that exact name is nearby. Needs Accessibility access."
          control={
            v.variables ? (
              <Switch
                id="vibe-variables"
                label="Variable recognition"
                describedBy={describedBy("vibe-variables")}
                checked
                onCheckedChange={(on) =>
                  void save({ vibeCoding: { variables: on } })
                }
              />
            ) : (
              <Button
                id="vibe-variables"
                variant="primary"
                disabled={!accessibility}
                onClick={() => void save({ vibeCoding: { variables: true } })}
              >
                Set up
              </Button>
            )
          }
        />
        <SettingsRow
          label="File tagging in chat (Cursor, Windsurf, VS Code)"
          htmlFor="vibe-files"
          description="Say “at index dot tsx” or “index dot tsx file” in an editor and Murmur writes @index.tsx; “at src slash app dot ts” becomes @src/app.ts. To spell names like your files, Murmur reads the editor's window title and lists file names (names only, never contents) in the open project folder, found through the editor's list of recent folders. The list is kept in memory for a minute. Only known code file types are tagged. Needs Accessibility access for the window title."
          control={
            <Switch
              id="vibe-files"
              label="File tagging in chat"
              describedBy={describedBy("vibe-files")}
              checked={v.fileTagging}
              disabled={!accessibility && !v.fileTagging}
              onCheckedChange={(on) =>
                void save({ vibeCoding: { fileTagging: on } })
              }
            />
          }
        />
      </SettingsGroup>
      {!accessibility && (
        <SettingsGroup title="Accessibility">
          <SettingsRow
            label="Accessibility access"
            description="Reading the window title and nearby code needs Accessibility access, which is also what lets Murmur paste automatically."
            control={
              <>
                <StatusText tone="warning" live>
                  Off
                </StatusText>
                <Button
                  variant="primary"
                  onClick={() => void hub.requestAccessibility().then(refresh)}
                >
                  Allow…
                </Button>
                <Button
                  onClick={() => void hub.openSystemSettings("accessibility")}
                >
                  System Settings
                </Button>
              </>
            }
          />
        </SettingsGroup>
      )}
    </>
  );
}
