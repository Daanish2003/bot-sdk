import type { RoomMember, RoomMemberStatus } from "@botsdk/client/bot/contract";
import { CrownIcon } from "lucide-react";

import { useI18n } from "@botsdk/react/provider";
import { BotAvatar } from "./bot-avatar";

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
            <BotAvatar name={member.name} size={28} />
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
