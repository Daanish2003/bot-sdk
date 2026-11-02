import { Button } from "@/components/ui/button";
import {
  type AssignmentLogEntry,
  type AssignmentStatus,
  type BotAssignment,
  isEndedAssignment,
} from "@botsdk/client/bot/assignment";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "@botsdk/react/provider";
import { useRefusalToast } from "./refusal-toast";
import { runTime } from "./run-divider";

const statusKeys = {
  open: "bots.assignmentOpen",
  working: "bots.assignmentWorking",
  blocked: "bots.assignmentBlocked",
  done: "bots.assignmentDone",
  failed: "bots.assignmentFailed",
  cancelled: "bots.assignmentCancelled",
} as const satisfies Record<AssignmentStatus, string>;

/**
 * What the user can do to an Assignment: cancel it until it ends. `actingAssignments` holds the
 * Assignments with a cancel in flight.
 */
export type AssignmentActionHandlers = {
  onCancelAssignment: (assignmentId: string) => Promise<void>;
  actingAssignments: ReadonlySet<string>;
};

/** The id of the line under a Turn that a log row's link to it scrolls to. */
export const turnLineId = (turnId: string) => `turn-${turnId}`;

/** One row of the log: when, the status, who made it, its note and a link to its Turn. */
function LogRow({ entry }: { entry: AssignmentLogEntry }) {
  const { t, locale } = useI18n();
  const actor =
    entry.actor === "user"
      ? t("bots.assignmentActorUser")
      : entry.actor === "system"
        ? t("bots.assignmentActorSystem")
        : (entry.actorName ?? t("bots.assignmentActorGone"));
  return (
    <li data-log-entry={entry.id} className="flex flex-col">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-muted-foreground">{runTime(locale, entry.at)}</span>
        <span>{t(statusKeys[entry.status])}</span>
        <span className="text-muted-foreground">{t("bots.assignmentBy", { actor })}</span>
        {entry.turnId && (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() =>
              document.getElementById(turnLineId(entry.turnId!))?.scrollIntoView?.({
                block: "center",
              })
            }
          >
            {t("bots.assignmentTurn")}
          </button>
        )}
      </span>
      {entry.note && <span className="pl-2 whitespace-pre-wrap">{entry.note}</span>}
    </li>
  );
}

/**
 * One Assignment handed to the Bot (spec #1166): a collapsed line with its title, who handed it
 * over and its status, opening to the work, its result once ended and its log, with Cancel until it
 * ends. Its Bot's Conversation and its Tasks view both show it so.
 */
export function AssignmentItem({
  assignment,
  onCancelAssignment,
  actingAssignments,
}: { assignment: BotAssignment } & AssignmentActionHandlers) {
  const { t } = useI18n();
  const run = useRefusalToast();
  const [open, setOpen] = useState(false);
  const { result } = assignment;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-assignment={assignment.id} data-status={assignment.status} className="w-full text-xs">
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="xs"
          className="h-auto min-w-0 flex-1 justify-start whitespace-normal text-left text-muted-foreground"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Chevron className="size-3 shrink-0" />
          <span className="min-w-0 break-words">
            {t("bots.assignmentFrom", {
              title: assignment.title,
              from: assignment.assignerName ?? t("bots.assignmentAnotherBot"),
            })}
          </span>
          <span className="ml-auto shrink-0">{t(statusKeys[assignment.status])}</span>
        </Button>
        {!isEndedAssignment(assignment.status) && (
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("bots.cancelAssignment", { title: assignment.title })}
            disabled={actingAssignments.has(assignment.id)}
            onClick={() => run(onCancelAssignment(assignment.id))}
          >
            {t("bots.cancel")}
          </Button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1 pt-1 pl-6">
          <p className="whitespace-pre-wrap">{assignment.instructions}</p>
          {result && (
            <>
              <p className="whitespace-pre-wrap text-muted-foreground">{result.outcome}</p>
              {result.forCustomer && (
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {t("bots.assignmentForCustomer", { text: result.forCustomer })}
                </p>
              )}
              {result.when && (
                <p className="text-muted-foreground">
                  {t("bots.assignmentWhen", { when: result.when })}
                </p>
              )}
            </>
          )}
          <ol aria-label={t("bots.assignmentLog")} className="flex flex-col gap-1 pt-1">
            {assignment.log.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
