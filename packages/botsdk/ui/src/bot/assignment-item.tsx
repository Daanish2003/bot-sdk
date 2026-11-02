import { Button } from "@/components/ui/button";
import type { AssignmentStatus, BotAssignment } from "@botsdk/client/bot/assignment";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "@botsdk/react/provider";

const statusKeys = {
  open: "bots.assignmentOpen",
  working: "bots.assignmentWorking",
  blocked: "bots.assignmentBlocked",
  done: "bots.assignmentDone",
  failed: "bots.assignmentFailed",
  cancelled: "bots.assignmentCancelled",
} as const satisfies Record<AssignmentStatus, string>;

/**
 * One Assignment handed to the Bot (spec #1166), read-only: a collapsed line with its title, who
 * handed it over and its status, opening to the work and, once ended, its result. Its Bot's
 * Conversation and its Tasks view both show it so.
 */
export function AssignmentItem({ assignment }: { assignment: BotAssignment }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { result } = assignment;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-assignment={assignment.id} data-status={assignment.status} className="w-full text-xs">
      <Button
        variant="ghost"
        size="xs"
        className="h-auto w-full justify-start whitespace-normal text-left text-muted-foreground"
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
        </div>
      )}
    </div>
  );
}
