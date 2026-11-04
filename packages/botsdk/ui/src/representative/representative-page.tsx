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
  useDeclineApproval,
  useDraftDiff,
  useRefreshRepresentatives,
  useRepresentativeDetail,
  useRollbackRelease,
  useRunTests,
  useSetRepresentativeAssignmentDue,
  useSetRepresentativeBot,
  useSetRepresentativeCaps,
  useSetRepresentativeSpendingCaps,
  useSetRepresentativeQuietHours,
  useSetRepresentativeEnabled,
  useUpdateDraft,
} from "@botsdk/representative/react";
import {
  canonicalJson,
  type Draft,
  maxAssignmentDueMinutes,
  maxOutboundCap,
  type RepresentativeTool,
  type RepresentativeView,
  representativeTools,
} from "@botsdk/representative/client";

import { ModelPicker } from "../models/shell/model-picker";
import { LimitWarning } from "./limit-warning";
import { DraftDocuments, documentsOverCap, useDocumentChanges } from "./representative-documents";
import { ReplyDrafts } from "./reply-drafts";
import { RepresentativeThreads } from "./representative-threads";
import { TestConversationsEditor, TestResults } from "./representative-tests";

const toolKeys = {
  reply: "representative.toolReply",
  hand_to_bot: "representative.toolHandToBot",
  verify_customer: "representative.toolVerifyCustomer",
  read_customer_work: "representative.toolReadCustomerWork",
} as const satisfies Record<RepresentativeTool, string>;

/** The draft's fields that Save draft saves: its documents change on their own. */
function formFields({ documents: _documents, ...fields }: Draft) {
  return fields;
}

/** The draft's fields, saved together with Save draft. */
function DraftEditor({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [draft, setDraft] = useState(() => formFields(representative.draft));
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
  const { orpc } = useChatAdapter();
  const models = useQuery(orpc.models.list.queryOptions());
  const usableModels = models.data?.models ?? [];
  const modelListed = usableModels.some((model) => model.id === draft.model);
  const [reason, setReason] = useState("");
  const documentChanges = useDocumentChanges();
  const busy = save.isPending || approve.isPending || run.isPending || documentChanges.pending;
  const body = { id: representative.id, draft };
  // Saving changes the draft, which voids its results, so a form with edits has no passing tests.
  const dirty = canonicalJson(draft) !== canonicalJson(formFields(representative.draft));
  // No reason gets past this: the owner chooses what matters, in the documents' section.
  const overCap = documentsOverCap(representative);
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
        <p className="text-sm font-medium">{t("representative.model")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <ModelPicker
            value={draft.model ?? undefined}
            models={usableModels}
            onSelect={(model) => setDraft({ ...draft, model })}
            invalid={models.isSuccess && draft.model !== null && !modelListed}
          />
          {draft.model !== null && (
            <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, model: null })}>
              {t("representative.modelUseDefault")}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("representative.modelHelp")}</p>
      </div>
      <DraftDocuments representative={representative} changes={documentChanges} busy={busy} />
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
          disabled={busy || blocked || overCap}
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
            disabled={busy || overCap || reason.trim() === ""}
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

/** The caps on what the Outbound gate sends one Customer, which the owner edits outside any Release. */
function CapsForm({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const { maxInARow, maxPerDay } = representative.caps;
  const setCaps = useSetRepresentativeCaps({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.capsSaved"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <form
      data-representative-caps=""
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setCaps.mutate({
          id: representative.id,
          maxInARow: Number(form.get("maxInARow")),
          maxPerDay: Number(form.get("maxPerDay")),
        });
      }}
    >
      <h2 className="text-sm font-medium">{t("representative.caps")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.capsHelp")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="representative-max-in-a-row">{t("representative.maxInARow")}</Label>
          <Input
            id="representative-max-in-a-row"
            name="maxInARow"
            type="number"
            min={1}
            max={maxOutboundCap}
            defaultValue={maxInARow}
            required
            className="w-28"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="representative-max-per-day">{t("representative.maxPerDay")}</Label>
          <Input
            id="representative-max-per-day"
            name="maxPerDay"
            type="number"
            min={1}
            max={maxOutboundCap}
            defaultValue={maxPerDay}
            required
            className="w-28"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={setCaps.isPending}>
          {t("representative.saveCaps")}
        </Button>
      </div>
    </form>
  );
}

/** How long work the Representative hands to a Bot may run before it is overdue: the owner's, in no Release. */
function AssignmentDueForm({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const setDue = useSetRepresentativeAssignmentDue({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.assignmentDueSaved"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <form
      data-representative-assignment-due=""
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setDue.mutate({ id: representative.id, minutes: Number(form.get("minutes")) });
      }}
    >
      <h2 className="text-sm font-medium">{t("representative.assignmentDue")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.assignmentDueHelp")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="representative-assignment-due">
            {t("representative.assignmentDueMinutes")}
          </Label>
          <Input
            id="representative-assignment-due"
            name="minutes"
            type="number"
            min={1}
            max={maxAssignmentDueMinutes}
            defaultValue={representative.assignmentDueMinutes}
            required
            className="w-28"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={setDue.isPending}>
          {t("representative.saveAssignmentDue")}
        </Button>
      </div>
    </form>
  );
}

/** The hours the Outbound gate holds what the business starts, and the business's time zone: the owner's, in no Release. */
function QuietHoursForm({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const { startHour, endHour, timeZone } = representative.quietHours;
  const setQuietHours = useSetRepresentativeQuietHours({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.quietHoursSaved"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <form
      data-representative-quiet-hours=""
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setQuietHours.mutate({
          id: representative.id,
          startHour: Number(form.get("startHour")),
          endHour: Number(form.get("endHour")),
          timeZone: String(form.get("timeZone")),
        });
      }}
    >
      <h2 className="text-sm font-medium">{t("representative.quietHours")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.quietHoursHelp")}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="representative-quiet-start">{t("representative.quietStart")}</Label>
          <Input
            id="representative-quiet-start"
            name="startHour"
            type="number"
            min={0}
            max={23}
            defaultValue={startHour}
            required
            className="w-28"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="representative-quiet-end">{t("representative.quietEnd")}</Label>
          <Input
            id="representative-quiet-end"
            name="endHour"
            type="number"
            min={0}
            max={23}
            defaultValue={endHour}
            required
            className="w-28"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="representative-business-time-zone">
            {t("representative.businessTimeZone")}
          </Label>
          <Input
            id="representative-business-time-zone"
            name="timeZone"
            defaultValue={timeZone}
            required
            className="w-48"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={setQuietHours.isPending}>
          {t("representative.saveQuietHours")}
        </Button>
      </div>
    </form>
  );
}

const microsPerDollar = 1_000_000;

/** The caps on what the Representative may cost, which the owner edits outside any Release (ticket #1310). */
function SpendingCapsForm({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const caps = representative.spendingCaps;
  const save = useSetRepresentativeSpendingCaps({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.spendingSaved"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const fields = [
    ["threadCalls", "representative.threadCalls", "calls"],
    ["threadMicros", "representative.threadUsd", "usd"],
    ["customerCalls", "representative.customerCalls", "calls"],
    ["customerMicros", "representative.customerUsd", "usd"],
    ["strangerCalls", "representative.strangerCalls", "calls"],
    ["strangerMicros", "representative.strangerUsd", "usd"],
    ["monthMicros", "representative.monthUsd", "usd"],
  ] as const;
  return (
    <form
      data-representative-spending=""
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        save.mutate({
          id: representative.id,
          ...Object.fromEntries(
            fields.map(([name, , unit]) => [
              name,
              unit === "usd"
                ? Math.round(Number(form.get(name)) * microsPerDollar)
                : Number(form.get(name)),
            ]),
          ),
        });
      }}
    >
      <h2 className="text-sm font-medium">{t("representative.spending")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.spendingHelp")}</p>
      <div className="flex flex-wrap items-end gap-3">
        {fields.map(([name, label, unit]) => (
          <div key={name} className="space-y-1">
            <Label htmlFor={`representative-${name}`}>{t(label)}</Label>
            <Input
              id={`representative-${name}`}
              name={name}
              type="number"
              min={unit === "usd" ? 0.01 : 1}
              step={unit === "usd" ? 0.01 : 1}
              defaultValue={unit === "usd" ? caps[name] / microsPerDollar : caps[name]}
              required
              className="w-28"
            />
          </div>
        ))}
        <Button type="submit" variant="outline" size="sm" disabled={save.isPending}>
          {t("representative.saveSpending")}
        </Button>
      </div>
    </form>
  );
}

/** A Bot's draft waiting for the owner: the Approve button above says yes, this says no. */
function WaitingApproval({ representative }: { representative: RepresentativeView }) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const refresh = useRefreshRepresentatives();
  const decline = useDeclineApproval({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.declined"));
    },
    onError: async (error) => {
      await refresh();
      toast.error(serverErrorText(i18n, error));
    },
  });
  const { approval } = representative;
  if (!approval) return null;
  return (
    <section
      data-representative-approval=""
      className="space-y-2 rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm dark:bg-amber-950/30"
    >
      <p>{t("representative.approvalWaiting")}</p>
      <p className="text-xs text-muted-foreground">
        {t("representative.approvalUntil", {
          date: new Date(approval.expiresAt).toLocaleString(locale),
        })}
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={decline.isPending}
        onClick={() => decline.mutate({ id: representative.id })}
      >
        {t("representative.declineApproval")}
      </Button>
    </section>
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
      <LimitWarning monthUsedPercent={representative.monthUsedPercent} />
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
      <CapsForm representative={representative} />
      <SpendingCapsForm representative={representative} />
      <QuietHoursForm representative={representative} />
      <AssignmentDueForm representative={representative} />
      <WaitingApproval representative={representative} />
      {/* Keyed by the draft's fields, so a draft changed elsewhere reloads the form. A document uploaded leaves the form's edits alone. */}
      <DraftEditor
        key={JSON.stringify(formFields(representative.draft))}
        representative={representative}
      />
      <DraftDiff id={id} />
      <ReplyDrafts id={id} />
      <RepresentativeThreads id={id} />
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
                className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="flex-1 font-medium">
                  {t("representative.release", { number: release.number })}
                </span>
                {release.overrideReason !== null && (
                  <span data-override-reason className="order-last w-full break-words text-xs">
                    {t("representative.overrideLogged", { reason: release.overrideReason })}
                  </span>
                )}
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
