import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useApproveRelease,
  useDraftDiff,
  useRefreshRepresentatives,
  useRepresentativeDetail,
  useRollbackRelease,
  useRunTests,
  useSetRepresentativeBot,
  useSetRepresentativeEnabled,
  useUpdateDraft,
} from "@botsdk/representative/react";
import {
  type Draft,
  type RepresentativeTool,
  type RepresentativeView,
  representativeTools,
} from "@botsdk/representative/client";

import { TestConversationsEditor, TestResults } from "./representative-tests";

/** `value` as JSON with its keys in order: Postgres keeps an object's keys in an order of its own. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, each: unknown) =>
    each && typeof each === "object" && !Array.isArray(each)
      ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : each,
  );

const toolKeys = {
  reply: "representative.toolReply",
  hand_to_bot: "representative.toolHandToBot",
} as const satisfies Record<RepresentativeTool, string>;

/** The draft's fields, saved together with Save draft. */
function DraftEditor({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [draft, setDraft] = useState<Draft>(representative.draft);
  const save = useUpdateDraft({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.draftSaved"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const approve = useApproveRelease({
    onSuccess: async (release) => {
      await refresh();
      toast.success(t("representative.approved", { number: release.number }));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const run = useRunTests({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.runTestsStarted"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const [reason, setReason] = useState("");
  const busy = save.isPending || approve.isPending || run.isPending;
  const body = { id: representative.id, draft };
  // Saving changes the draft, which voids its results, so a form with edits has no passing tests.
  const dirty = stable(draft) !== stable(representative.draft);
  // Tests that failed, or haven't run for this draft, hold Approve back until a reason is given.
  const blocked =
    draft.tests.length > 0 &&
    (dirty || (representative.testStatus !== "none" && representative.testStatus !== "passed"));
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("representative.draft")}</h2>
        <p className="text-xs text-muted-foreground">{t("representative.draftHelp")}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="representative-job">{t("representative.jobText")}</Label>
        <Textarea
          id="representative-job"
          rows={8}
          value={draft.jobText}
          placeholder={t("representative.jobTextPlaceholder")}
          onChange={(event) => setDraft({ ...draft, jobText: event.target.value })}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("representative.tools")}</legend>
        {representativeTools.map((tool) => (
          <div key={tool} className="flex items-center gap-2">
            <Checkbox
              id={`representative-tool-${tool}`}
              checked={draft.tools.includes(tool)}
              onCheckedChange={(checked) =>
                setDraft({
                  ...draft,
                  tools: representativeTools.filter((each) =>
                    each === tool ? checked : draft.tools.includes(each),
                  ),
                })
              }
            />
            <Label htmlFor={`representative-tool-${tool}`}>{t(toolKeys[tool])}</Label>
          </div>
        ))}
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor="representative-model">{t("representative.model")}</Label>
        <Input
          id="representative-model"
          value={draft.model ?? ""}
          placeholder={t("representative.modelPlaceholder")}
          onChange={(event) =>
            setDraft({
              ...draft,
              model: event.target.value.trim() === "" ? null : event.target.value,
            })
          }
        />
      </div>
      <TestConversationsEditor
        tests={draft.tests}
        onChange={(tests) => setDraft({ ...draft, tests })}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => save.mutate(body)}>
          {t("representative.saveDraft")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || draft.tests.length === 0}
          // The tests run on the saved draft: the form's edits are saved first.
          onClick={() =>
            save
              .mutateAsync(body)
              .then(() => run.mutateAsync({ id: representative.id }))
              .catch(() => {})
          }
        >
          {t("representative.runTests")}
        </Button>
        <Button
          disabled={busy || blocked}
          // The server approves what it holds: the form's edits are saved first.
          onClick={() =>
            save
              .mutateAsync(body)
              .then(() => approve.mutateAsync({ id: representative.id }))
              // Each step shows its own refusal.
              .catch(() => {})
          }
        >
          {t("representative.approve")}
        </Button>
      </div>
      <TestResults representative={representative} />
      {blocked && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("representative.overrideHelp")}</p>
          <Label htmlFor="representative-override">{t("representative.overrideReason")}</Label>
          <Input
            id="representative-override"
            value={reason}
            maxLength={1_000}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || reason.trim() === ""}
            onClick={() =>
              // The reason belongs to the draft it is given for: its edits are saved first.
              save
                .mutateAsync(body)
                .then(() => approve.mutateAsync({ id: representative.id, overrideReason: reason }))
                .catch(() => {})
            }
          >
            {t("representative.approveAnyway")}
          </Button>
        </div>
      )}
    </section>
  );
}

/** What the draft changes against the live Release, so the owner reviews only that. */
function DraftDiff({ id }: { id: string }) {
  const { t } = useI18n();
  const { data: diff, isError } = useDraftDiff(id);
  // A failed diff says so: no diff must never read as no changes.
  if (isError) return <p className="text-sm text-destructive">{t("representative.diffFailed")}</p>;
  if (!diff) return null;
  // A value is JSON text; null is a side that has none.
  const show = (value: string | null) => (value === null ? t("representative.diffAbsent") : value);
  return (
    <section className="space-y-2" aria-label={t("representative.diff")}>
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("representative.diff")}</h2>
        <p className="text-xs text-muted-foreground">
          {diff.liveReleaseNumber === null
            ? t("representative.diffNew")
            : t("representative.diffHelp")}
        </p>
      </div>
      {diff.changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("representative.diffNone")}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {diff.changes.map((change, index) => (
            <li
              key={`${index}:${change.field}:${change.name ?? ""}`}
              data-change={change.field}
              className="space-y-1 px-4 py-3 text-sm"
            >
              <p className="font-medium">
                {t(`representative.diffField.${change.field}`)}
                {change.name !== null && `: ${change.name}`}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                {t("representative.diffBefore")}: {show(change.before)}
              </p>
              <p className="break-words text-xs">
                {t("representative.diffAfter")}: {show(change.after)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The Bot chooser, limited to the owner's Bots; with none chosen, the Representative reports to the owner. */
function BotChooser({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { orpc } = useChatAdapter();
  const bots = useQuery(orpc.bots.list.queryOptions());
  const refresh = useRefreshRepresentatives();
  const setBot = useSetRepresentativeBot({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.botChosen"));
    },
    // The Bot may have changed before the refusal: show what the server holds.
    onError: async (error) => {
      await refresh();
      toast.error(serverErrorText(i18n, error));
    },
  });
  return (
    <div className="space-y-1">
      <Label htmlFor="representative-reports-to">{t("representative.reportsTo")}</Label>
      <select
        id="representative-reports-to"
        value={representative.botId ?? ""}
        disabled={setBot.isPending}
        onChange={(event) => {
          if (event.target.value)
            setBot.mutate({ id: representative.id, botId: event.target.value });
        }}
        className="block h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
      >
        {representative.botId === null && (
          <option value="">{t("representative.reportsToYou")}</option>
        )}
        {bots.data?.map((bot) => (
          <option key={bot.id} value={bot.id}>
            {bot.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t("representative.reportsToHelp")}</p>
    </div>
  );
}

/**
 * One Representative: who it reports to, on/off, its draft with Save draft and Approve, and its
 * Releases. The Host mounts it at `/representatives/<id>`.
 */
export function RepresentativePage({ id }: { id: string }) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const { Link } = useChatAdapter();
  const detail = useRepresentativeDetail(id);
  const refresh = useRefreshRepresentatives();
  const setEnabled = useSetRepresentativeEnabled({
    onSuccess: refresh,
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const rollBack = useRollbackRelease({
    onSuccess: async (view) => {
      await refresh();
      toast.success(t("representative.rolledBack", { number: view.liveReleaseNumber ?? 0 }));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const representative = detail.data;
  if (!representative) return <main className="mx-auto w-full max-w-2xl p-6" />;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <Link page={{ to: "representatives" }} className="text-xs text-muted-foreground underline">
        {t("representative.back")}
      </Link>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{representative.name}</h1>
        <p className="text-sm text-muted-foreground">
          {representative.liveReleaseNumber === null
            ? t("representative.noRelease")
            : t("representative.live", { number: representative.liveReleaseNumber })}
        </p>
      </div>
      <BotChooser representative={representative} />
      <div className="flex items-center gap-2">
        <Checkbox
          id="representative-enabled"
          checked={representative.enabled}
          disabled={
            setEnabled.isPending || (!representative.enabled && representative.liveRelease === null)
          }
          onCheckedChange={(enabled) => setEnabled.mutate({ id, enabled })}
        />
        <Label htmlFor="representative-enabled">{t("representative.switch")}</Label>
      </div>
      {/* Keyed by the draft's fields, so a draft changed elsewhere reloads the form. */}
      <DraftEditor key={JSON.stringify(representative.draft)} representative={representative} />
      <DraftDiff id={id} />
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.releases")}</h2>
        {representative.releases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("representative.noReleases")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border">
            {representative.releases.map((release) => (
              <li
                key={release.id}
                data-release={release.number}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="flex-1 font-medium">
                  {t("representative.release", { number: release.number })}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(release.approvedAt).toLocaleString(locale)}
                </span>
                {release.id === representative.liveRelease?.id ? (
                  <span className="text-xs">{t("representative.liveBadge")}</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={rollBack.isPending}
                    aria-label={`${t("representative.rollBack")} ${release.number}`}
                    onClick={() => rollBack.mutate({ id, releaseId: release.id })}
                  >
                    {t("representative.rollBack")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
