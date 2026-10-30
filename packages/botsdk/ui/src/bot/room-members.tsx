import type { RoomMember, RoomMemberStatus } from "@botsdk/client/bot/contract";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CrownIcon } from "lucide-react";
import { toast } from "sonner";

import { useBotCheckIns } from "@botsdk/react/bot/check-ins";
import { useBotHelpers } from "@botsdk/react/bot/helpers";
import { useBotPause } from "@botsdk/react/bot/pause";
import { useBotRoutines } from "@botsdk/react/bot/routines";
import { useBotTasks, useSkipTrigger } from "@botsdk/react/bot/tasks";
import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { BotAvatar } from "./bot-avatar";
import { BotMenu, PausedBadge } from "./bot-menu";
import { TasksPopover } from "./tasks-popover";

/** Each status's dot colour. */
const dotClass: Record<RoomMemberStatus, string> = {
  working: "bg-emerald-500",
  queued: "bg-sky-500",
  paused: "bg-amber-500",
};

/**
 * A Room's members in its header (spec #1055): an avatar stack in the order they joined, the lead
 * marked with a crown, and a status dot on each that is working, queued or paused.
 */
export function RoomMembers({ members }: { members: RoomMember[] }) {
  const { t } = useI18n();
  const statusText: Record<RoomMemberStatus, string> = {
    working: t("bots.memberWorking"),
    queued: t("bots.memberQueued"),
    paused: t("bots.memberPaused"),
  };
  return (
    <ul aria-label={t("bots.roomMembers")} className="flex items-center -space-x-2">
      {members.map((member) => {
        const label = t("bots.roomMember", {
          name: member.name,
          lead: member.lead ? t("bots.lead") : "",
          status: member.status ? statusText[member.status] : "",
        });
        return (
          <li
            key={member.botId}
            aria-label={label}
            title={label}
            className="relative rounded-full ring-2 ring-background"
          >
            <Popover>
              <PopoverTrigger
                aria-label={t("bots.memberControls", { name: member.name })}
                className="block rounded-full"
              >
                <BotAvatar name={member.name} size={28} />
              </PopoverTrigger>
              <PopoverContent className="w-auto">
                <MemberControls
                  member={member}
                  status={member.status ? statusText[member.status] : ""}
                />
              </PopoverContent>
            </Popover>
            {member.lead && (
              <CrownIcon
                aria-hidden
                className="absolute -top-2 left-1/2 size-3 -translate-x-1/2 text-amber-600"
              />
            )}
            {member.status && (
              <span
                aria-hidden
                data-status={member.status}
                className={`absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-background ${dotClass[member.status]}`}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A member's popover (spec #1055): its name and status, its Tasks view and its ⋯ menu with pause and
 * reset, the same controls as on the Bot page. It is mounted only while open, so it reads nothing before.
 */
function MemberControls({ member, status }: { member: RoomMember; status: string }) {
  const i18n = useI18n();
  const { orpc } = useChatAdapter();
  const { botId, name } = member;
  const working = member.status === "working";
  const refuse = (refusal: unknown) => toast.error(serverErrorText(i18n, refusal));
  const { tasks } = useBotTasks(botId, working);
  const routines = useBotRoutines(botId, working);
  const checkIns = useBotCheckIns(botId, working);
  const helpers = useBotHelpers(botId, working);
  const skip = useSkipTrigger(botId);
  const pause = useBotPause(botId);
  const paused = member.status === "paused";
  return (
    <div className="flex items-center gap-2">
      <BotAvatar name={name} size={28} />
      <span className="font-medium">{name}</span>
      {paused ? (
        <PausedBadge />
      ) : (
        status && <span className="text-xs text-muted-foreground">{status}</span>
      )}
      {tasks && (
        <TasksPopover
          tasks={tasks}
          onStopTurn={() => void orpc.bots.stop.call({ botId }).catch(refuse)}
          onStopHelper={(helperId) => void helpers.stop(helperId).catch(refuse)}
          actingHelpers={helpers.acting}
          onCancelCheckIn={checkIns.cancel}
          actingCheckIns={checkIns.acting}
          onSkipTrigger={skip.skip}
          actingTriggers={skip.actingTriggers}
          webhookTokens={routines.webhookTokens}
          onRotate={routines.rotate}
          onEditRoutine={routines.edit}
          onEditCheckIn={checkIns.edit}
          onPause={routines.pause}
          onResume={routines.resume}
          onDelete={routines.remove}
          actingRoutines={routines.acting}
        />
      )}
      <BotMenu
        name={name}
        paused={paused}
        acting={pause.acting}
        onPause={() => void pause.pause().catch(refuse)}
        onResume={() => void pause.resume().catch(refuse)}
        onReset={(typed) =>
          pause.reset(typed).catch((refusal) => {
            refuse(refusal);
            throw refusal;
          })
        }
      />
    </div>
  );
}
