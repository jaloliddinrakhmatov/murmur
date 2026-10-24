// Style (reference 07): tabs for Personal messages, Work messages, Email and Other (Stage E part 2:
// a writing style per kind of app, settings.styles), and Auto cleanup: how much Murmur tidies
// each dictation, the existing cleanup setting (settings.cleanup.mode) under the reference's
// names; Settings → AI cleanup shows the same setting and holds the AI service configuration.
import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { Settings } from "../../../shared/settings.ts";
import { hub } from "../bridge.ts";
import {
  Badge,
  Banner,
  Button,
  ChoiceCards,
  InlineAlert,
  UnderlineTabs,
  useStoredChoice,
} from "../ui/index.ts";
import { PageHeader } from "../shell/shell.tsx";
import { useSave } from "../settings/common.tsx";
import { STYLE_CARDS, STYLE_LEVELS } from "../model/style.ts";
import {
  APP_CATEGORIES,
  CATEGORY_APPS,
  CATEGORY_LABELS,
  type AppCategory,
} from "../../../shared/styles.ts";
import { AI_LABELS, aiQualityChecked } from "../model/settings.ts";
import type { SettingsTarget } from "../model/settings-sections.ts";

export function StylePage({
  settings,
  update,
  openSettings,
}: {
  settings: Settings;
  update: (p: unknown) => Promise<void>;
  openSettings: (target: SettingsTarget) => void;
}) {
  const save = useSave(update);
  const mode = settings.cleanup.mode;
  const [aiReady, setAiReady] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (mode !== "ai") return;
    void hub
      .aiCleanupStatus()
      .then((s) => setAiReady(s.ready))
      .catch(() => setAiReady(undefined));
  }, [mode, settings.cleanup.aiProvider, settings.cleanup.aiModel]);
  const service = AI_LABELS[settings.cleanup.aiProvider];
  const [tab, setTab] = useStoredChoice<AppCategory | "cleanup">(
    "murmur.style.tab",
    [...APP_CATEGORIES, "cleanup"],
    "cleanup",
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Style" />
      <UnderlineTabs
        label="Style for"
        value={tab}
        onChange={setTab}
        options={[
          ...APP_CATEGORIES.map((c) => ({
            value: c,
            label: CATEGORY_LABELS[c],
          })),
          {
            value: "cleanup" as const,
            label: "Auto cleanup",
            badge: <Badge tone="accent">Beta</Badge>,
          },
        ]}
      />
      {tab !== "cleanup" ? (
        <CategoryStyle
          category={tab}
          settings={settings}
          off={mode === "off"}
          onChange={(style) => void save({ styles: { [tab]: style } })}
        />
      ) : (
        <>
          <Banner scene="style" title="Cleanup applies to every dictation">
            <p>
              Choose how much Murmur tidies what you say, in every app. Your
              dictionary and snippets apply at every level.
            </p>
            <p>
              The words you actually said are kept in History, whichever level
              you choose.
            </p>
          </Banner>
          <ChoiceCards
            label="Cleanup level"
            value={mode}
            onChange={(m) => void save({ cleanup: { mode: m } })}
            options={STYLE_LEVELS.map((l) => ({
              value: l.mode,
              title: l.name,
              description: l.description,
              footer: (
                <span className="block rounded-lg bg-accent-faint px-4 py-3">
                  <span className="block text-caption italic leading-[20px] text-fg">
                    {l.example}
                  </span>
                  {!l.exampleIsReal && (
                    <span className="mt-2 block text-micro font-medium uppercase text-fg-secondary">
                      Illustration · AI output varies
                    </span>
                  )}
                </span>
              ),
            }))}
          />
          {mode === "ai" && aiReady !== undefined && (
            <InlineAlert
              tone="warning"
              icon={<ShieldAlert />}
              action={
                <Button size="sm" onClick={() => openSettings("ai")}>
                  {aiReady === null ? "AI settings" : "Set up AI service"}
                </Button>
              }
            >
              {aiReady === null ? (
                <>
                  <strong className="font-semibold">
                    {aiQualityChecked(
                      settings.cleanup.aiProvider,
                      settings.cleanup.aiModel,
                    )
                      ? "Passed Murmur's quality check."
                      : "This model hasn't been quality-checked."}
                  </strong>{" "}
                  The transcript of every dictation is sent to {service} for
                  cleanup.
                </>
              ) : (
                <>
                  <strong className="font-semibold">
                    {service} isn't set up yet.
                  </strong>{" "}
                  Until it is, Murmur uses Light cleanup.
                </>
              )}
            </InlineAlert>
          )}
        </>
      )}
    </div>
  );
}

/** One kind of app: which apps count, and Formal / Casual / Very casual with live examples. */
function CategoryStyle({
  category,
  settings,
  off,
  onChange,
}: {
  category: AppCategory;
  settings: Settings;
  off: boolean;
  onChange: (style: Settings["styles"][AppCategory]) => void;
}) {
  const apps =
    category === "other"
      ? "Every other app: browsers, notes, editors and the rest."
      : `${CATEGORY_APPS[category].map((a) => a.name).join(", ")}.`;
  return (
    <>
      <Banner
        scene="style"
        title={`How you write in ${CATEGORY_LABELS[category].toLowerCase()}`}
      >
        <p>Murmur uses this style when you dictate into: {apps}</p>
        <p>
          It's applied after cleanup, on this Mac. Your dictionary and snippets
          still apply.
        </p>
      </Banner>
      {off && (
        <InlineAlert tone="warning" icon={<ShieldAlert />}>
          Auto cleanup is set to None, so dictations are inserted exactly as
          heard and no style is applied.
        </InlineAlert>
      )}
      <ChoiceCards
        label={`Style for ${CATEGORY_LABELS[category]}`}
        value={settings.styles[category]}
        onChange={onChange}
        options={STYLE_CARDS.map((c) => ({
          value: c.style,
          title: c.name,
          description: c.description,
          footer: (
            <span className="block rounded-lg bg-accent-faint px-4 py-3">
              <span className="block text-caption italic leading-[20px] text-fg">
                {c.example}
              </span>
            </span>
          ),
        }))}
      />
    </>
  );
}
