import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useAddFact,
  useApproveFactProposal,
  useDeclineFactProposal,
  useDeleteFact,
  useDismissGap,
  useEditFact,
  useFactLog,
  useFactProposals,
  useFacts,
  useGapToFact,
  useGaps,
  useRefreshRepresentatives,
} from "@botsdk/representative/react";
import {
  type FactLogView,
  type FactProposalView,
  type FactSnapshot,
  type FactType,
  type FactView,
  factTypes,
  type GapView,
} from "@botsdk/representative/client";

const toDateField = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : "");
const fromDateField = (value: string) => (value === "" ? null : new Date(`${value}T00:00:00Z`));

type Fields = {
  type: FactType;
  topic: string;
  value: string;
  validFrom: Date | null;
  validUntil: Date | null;
};

/** The type, topic, value and valid dates of one fact, saved with a button. */
function FactFields({
  label,
  initial,
  submitLabel,
  disabled,
  onSubmit,
}: {
  label: string;
  initial: { type: FactType; topic: string; value: string; validFrom: string; validUntil: string };
  submitLabel: string;
  disabled: boolean;
  onSubmit: (value: Fields) => void;
}) {
  const { t } = useI18n();
  const [type, setType] = useState(initial.type);
  const [topic, setTopic] = useState(initial.topic);
  const [value, setValue] = useState(initial.value);
  const [validFrom, setValidFrom] = useState(initial.validFrom);
  const [validUntil, setValidUntil] = useState(initial.validUntil);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          type,
          topic,
          value,
          validFrom: fromDateField(validFrom),
          validUntil: fromDateField(validUntil),
        });
      }}
    >
      <select
        className="h-8 rounded-md border bg-background px-2 text-sm"
        aria-label={t("representative.facts.typeOf", { name: label })}
        value={type}
        onChange={(event) => setType(event.target.value as FactType)}
      >
        {factTypes.map((each) => (
          <option key={each} value={each}>
            {each}
          </option>
        ))}
      </select>
      <Input
        className="w-36"
        aria-label={t("representative.facts.topicOf", { name: label })}
        value={topic}
        maxLength={100}
        onChange={(event) => setTopic(event.target.value)}
      />
      <Input
        className="w-64"
        aria-label={t("representative.facts.valueOf", { name: label })}
        value={value}
        maxLength={2000}
        onChange={(event) => setValue(event.target.value)}
      />
      <Input
        className="w-40"
        type="date"
        aria-label={t("representative.facts.fromOf", { name: label })}
        value={validFrom}
        onChange={(event) => setValidFrom(event.target.value)}
      />
      <Input
        className="w-40"
        type="date"
        aria-label={t("representative.facts.untilOf", { name: label })}
        value={validUntil}
        onChange={(event) => setValidUntil(event.target.value)}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={disabled || topic.trim() === "" || value.trim() === ""}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

function FactRow({ fact }: { fact: FactView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const onError = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const edit = useEditFact({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.facts.saved"));
    },
    onError,
  });
  const remove = useDeleteFact({ onSuccess: () => refresh(), onError });
  return (
    <li data-fact={fact.key} data-in-effect={fact.inEffect} className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{fact.key}</span>
        {!fact.inEffect && (
          <span className="text-xs font-medium">{t("representative.facts.notInEffect")}</span>
        )}
        <Button
          className="ml-auto"
          variant="destructive"
          size="sm"
          disabled={remove.isPending}
          aria-label={t("representative.facts.deleteOf", { name: fact.key })}
          onClick={() => remove.mutate({ id: fact.id })}
        >
          {t("representative.facts.delete")}
        </Button>
      </div>
      <FactFields
        // Keyed by what is stored, so a refetch after a save reloads the fields.
        key={fact.updatedAt.getTime()}
        label={fact.key}
        initial={{
          type: fact.type,
          topic: fact.topic,
          value: fact.value,
          validFrom: toDateField(fact.validFrom),
          validUntil: toDateField(fact.validUntil),
        }}
        submitLabel={t("representative.facts.save")}
        disabled={edit.isPending}
        onSubmit={(value) => edit.mutate({ id: fact.id, ...value })}
      />
    </li>
  );
}

function NewFactForm() {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [key, setKey] = useState("");
  const [added, setAdded] = useState(0);
  const add = useAddFact({
    onSuccess: async () => {
      await refresh();
      setKey("");
      setAdded((count) => count + 1);
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor="fact-key">{t("representative.facts.key")}</Label>
        <Input
          id="fact-key"
          className="w-64"
          value={key}
          maxLength={64}
          onChange={(event) => setKey(event.target.value)}
        />
      </div>
      <FactFields
        // Remounted empty once a fact is added, and kept as typed when the add is refused.
        key={added}
        label={t("representative.facts.new")}
        initial={{ type: "text", topic: "General", value: "", validFrom: "", validUntil: "" }}
        submitLabel={t("representative.facts.add")}
        disabled={add.isPending || key.trim() === ""}
        onSubmit={(value) => add.mutate({ key, ...value })}
      />
    </div>
  );
}

/** One Gap: its question as plain text, how often it came up, and the ways to close it. */
function GapRow({ gap }: { gap: GapView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [key, setKey] = useState("");
  const onError = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const dismiss = useDismissGap({ onSuccess: () => refresh(), onError });
  const answer = useGapToFact({ onSuccess: () => refresh(), onError });
  return (
    <li data-gap={gap.id} className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* The Model wrote it: React shows it as text, never as markup. */}
        <span data-gap-question className="text-sm font-medium break-words">
          {gap.question}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("representative.facts.gapCount", { count: gap.count })}
        </span>
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={dismiss.isPending}
          aria-label={t("representative.facts.gapDismissOf", { name: gap.question })}
          onClick={() => dismiss.mutate({ id: gap.id })}
        >
          {t("representative.facts.gapDismiss")}
        </Button>
      </div>
      <Input
        className="w-64"
        aria-label={t("representative.facts.gapKeyOf", { name: gap.question })}
        placeholder={t("representative.facts.key")}
        value={key}
        maxLength={64}
        onChange={(event) => setKey(event.target.value)}
      />
      <FactFields
        label={t("representative.facts.gapNewFact")}
        initial={{ type: "text", topic: "General", value: "", validFrom: "", validUntil: "" }}
        submitLabel={t("representative.facts.gapToFact")}
        disabled={answer.isPending || key.trim() === ""}
        onSubmit={(value) => answer.mutate({ id: gap.id, key, ...value })}
      />
    </li>
  );
}

/** One side of a proposal, field by field; a fact the key doesn't have yet says so. */
function ProposalSide({
  side,
  title,
  fact,
  other,
}: {
  side: "current" | "proposed";
  title: string;
  fact: FactSnapshot | null;
  /** The other side: a field that differs from it is marked. */
  other: FactSnapshot | null;
}) {
  const { t } = useI18n();
  return (
    <div data-side={side} className="min-w-0 space-y-1 rounded-md border p-3 text-sm">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {fact ? (
        <dl className="space-y-1">
          {(
            [
              ["representative.facts.field.value", fact.value, other?.value],
              ["representative.facts.field.type", fact.type, other?.type],
              ["representative.facts.field.topic", fact.topic, other?.topic],
              [
                "representative.facts.field.from",
                toDateField(fact.validFrom),
                other && toDateField(other.validFrom),
              ],
              [
                "representative.facts.field.until",
                toDateField(fact.validUntil),
                other && toDateField(other.validUntil),
              ],
            ] as const
          ).map(
            ([label, value, otherValue]) =>
              value !== "" && (
                <div key={label} className="flex flex-wrap gap-x-2">
                  <dt className="text-xs text-muted-foreground">{t(label)}</dt>
                  <dd
                    data-changed={other !== null && value !== otherValue}
                    className="break-words data-[changed=true]:font-semibold"
                  >
                    {value}
                  </dd>
                </div>
              ),
          )}
        </dl>
      ) : (
        <p className="text-muted-foreground">{t("representative.facts.proposalNone")}</p>
      )}
    </div>
  );
}

/** A Bot's proposed fact: what it is now beside what it would become, answered here and nowhere else. */
function ProposalRow({ proposal }: { proposal: FactProposalView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const callbacks = {
    onSuccess: () => refresh(),
    onError: async (error: unknown) => {
      toast.error(serverErrorText(i18n, error));
      // Refused because it no longer waits, so the row should go.
      await refresh();
    },
  };
  const approve = useApproveFactProposal(callbacks);
  const decline = useDeclineFactProposal(callbacks);
  const acting = approve.isPending || decline.isPending;
  return (
    <li data-fact-proposal={proposal.key} className="space-y-2 p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-sm font-medium">{proposal.key}</span>
        <span className="text-xs text-muted-foreground">
          {t("representative.facts.proposalFrom", { name: proposal.botName })}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("representative.facts.proposalExpires", {
            date: proposal.expiresAt.toLocaleDateString(),
          })}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{proposal.why}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <ProposalSide
          side="current"
          title={t("representative.facts.proposalCurrent")}
          fact={proposal.current}
          other={proposal.proposed}
        />
        <ProposalSide
          side="proposed"
          title={t("representative.facts.proposalProposed")}
          fact={proposal.proposed}
          other={proposal.current}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={acting}
          aria-label={t("representative.facts.proposalApproveOf", { name: proposal.key })}
          onClick={() => approve.mutate({ id: proposal.id })}
        >
          {t("representative.facts.proposalApprove")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={acting}
          aria-label={t("representative.facts.proposalDeclineOf", { name: proposal.key })}
          onClick={() => decline.mutate({ id: proposal.id })}
        >
          {t("representative.facts.proposalDecline")}
        </Button>
      </div>
    </li>
  );
}

function LogRow({ entry }: { entry: FactLogView }) {
  const { t } = useI18n();
  return (
    <li data-log={entry.action} className="flex flex-wrap items-center gap-2 p-3 text-sm">
      <span className="font-medium">{t(`representative.facts.log.${entry.action}`)}</span>
      <span className="font-mono">{entry.key}</span>
      {entry.old && (
        <span className="text-xs text-muted-foreground">
          {t("representative.facts.logOld", { value: entry.old.value })}
        </span>
      )}
      {entry.new && (
        <span className="text-xs text-muted-foreground">
          {t("representative.facts.logNew", { value: entry.new.value })}
        </span>
      )}
      {entry.proposedBy && (
        <span className="text-xs text-muted-foreground">
          {t("representative.facts.logProposedBy", { name: entry.proposedBy })}
        </span>
      )}
      <time className="ml-auto text-xs text-muted-foreground" dateTime={entry.at.toISOString()}>
        {entry.at.toLocaleString()}
      </time>
    </li>
  );
}

/**
 * Facts: the owner's Published facts, grouped by topic, with a form to add one, and the log of
 * every change. They belong to the owner and are shared by every Representative, and an edit
 * applies at once. The Host mounts it at `/facts`.
 */
export function FactsPage() {
  const { t } = useI18n();
  const facts = useFacts();
  const log = useFactLog();
  const gaps = useGaps();
  const proposals = useFactProposals();
  // The list comes sorted by topic, so each topic's facts are together.
  const topics = new Map<string, FactView[]>();
  for (const fact of facts.data ?? [])
    topics.set(fact.topic, [...(topics.get(fact.topic) ?? []), fact]);
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t("representative.facts.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("representative.facts.intro")}</p>
      </div>
      {gaps.data && gaps.data.length > 0 && (
        <section data-gaps className="space-y-2">
          <h2 className="text-sm font-medium">{t("representative.facts.gapsTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("representative.facts.gapsIntro")}</p>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {gaps.data.map((gap) => (
              <GapRow key={gap.id} gap={gap} />
            ))}
          </ul>
        </section>
      )}
      {proposals.data && proposals.data.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t("representative.facts.proposalsTitle")}</h2>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {proposals.data.map((proposal) => (
              <ProposalRow key={proposal.id} proposal={proposal} />
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.facts.addTitle")}</h2>
        <NewFactForm />
      </section>
      {facts.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("representative.facts.none")}</p>
      )}
      {[...topics].map(([topic, inTopic]) => (
        <section key={topic} data-topic={topic} className="space-y-2">
          <h2 className="text-sm font-medium">{topic}</h2>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {inTopic.map((fact) => (
              <FactRow key={fact.id} fact={fact} />
            ))}
          </ul>
        </section>
      ))}
      {log.data && log.data.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t("representative.facts.logTitle")}</h2>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {log.data.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
