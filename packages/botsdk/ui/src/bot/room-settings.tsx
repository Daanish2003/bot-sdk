import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CrownIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import type { Room } from "@botsdk/client/bot/contract";
import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { BotAvatar } from "./bot-avatar";

/**
 * The warning on a Room with one Bot left (its others were deleted, spec #1055): only adding a Bot
 * or deleting the Room is allowed.
 */
export function OneBotWarning({ room }: { room: Room }) {
  const { t } = useI18n();
  return (
    <p
      role="alert"
      className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900"
    >
      <TriangleAlertIcon className="size-4 shrink-0" aria-hidden />
      {t("bots.oneBotRoom", { name: room.members[0]?.name ?? "" })}
    </p>
  );
}

/**
 * Room settings (spec #1055), from the header's "⋯": rename the Room, add and remove Bots, change
 * the lead, and delete it. A Room keeps two Bots, so removing is off at two; with one Bot left only
 * adding a Bot and deleting the Room work.
 */
export function RoomSettingsDialog({
  room,
  open,
  onOpenChange,
}: {
  room: Room;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { orpc, navigate } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const queryClient = useQueryClient();
  const { conversationId } = room;
  const [name, setName] = useState(room.name);
  const [deleting, setDeleting] = useState(false);
  const bots = useQuery(orpc.bots.list.queryOptions());

  const reread = () => {
    void queryClient.invalidateQueries({
      queryKey: orpc.rooms.get.queryKey({ input: { conversationId } }),
    });
    void queryClient.invalidateQueries({ queryKey: orpc.rooms.list.queryKey() });
  };
  const options = {
    onSuccess: reread,
    onError: (error: unknown) => toast.error(serverErrorText(i18n, error)),
  };
  const rename = useMutation(orpc.rooms.rename.mutationOptions(options));
  const add = useMutation(orpc.rooms.addMember.mutationOptions(options));
  const remove = useMutation(orpc.rooms.removeMember.mutationOptions(options));
  const lead = useMutation(orpc.rooms.setLead.mutationOptions(options));
  const destroy = useMutation(
    orpc.rooms.delete.mutationOptions({
      onSuccess: async () => {
        onOpenChange(false);
        queryClient.removeQueries({
          queryKey: orpc.rooms.get.queryKey({ input: { conversationId } }),
        });
        void queryClient.invalidateQueries({ queryKey: orpc.rooms.list.queryKey() });
        await navigate({ to: "bots" });
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const oneBot = room.members.length < 2;
  const memberIds = new Set(room.members.map((member) => member.botId));
  const addable = (bots.data ?? []).filter((bot) => !memberIds.has(bot.id));
  const busy = rename.isPending || add.isPending || remove.isPending || lead.isPending;
  const trimmed = name.trim();
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed && trimmed !== room.name && !oneBot)
      rename.mutate({ conversationId, name: trimmed });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setDeleting(false);
          setName(room.name);
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("bots.roomSettings")}</DialogTitle>
          <DialogDescription>{room.name}</DialogDescription>
        </DialogHeader>
        {oneBot && <OneBotWarning room={room} />}
        <form onSubmit={save} className="flex gap-2">
          <Input
            aria-label={t("bots.roomName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            disabled={oneBot}
          />
          <Button
            type="submit"
            disabled={oneBot || !trimmed || trimmed === room.name || rename.isPending}
          >
            {t("bots.save")}
          </Button>
        </form>
        <section aria-label={t("bots.roomMembers")} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("bots.roomMembers")}
          </h3>
          <ul className="flex flex-col gap-1">
            {room.members.map((member) => (
              <li
                key={member.botId}
                className="flex items-center gap-2 rounded-md border px-3 py-2"
              >
                <BotAvatar name={member.name} size={24} />
                <span className="flex-1 truncate text-sm">{member.name}</span>
                {member.lead ? (
                  <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                    <CrownIcon className="size-3" />
                    {t("bots.lead")}
                  </span>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={oneBot || busy}
                    onClick={() => lead.mutate({ conversationId, botId: member.botId })}
                  >
                    {t("bots.makeLead")}
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t("bots.removeFromRoom", { name: member.name })}
                  disabled={room.members.length <= 2 || busy}
                  onClick={() => remove.mutate({ conversationId, botId: member.botId })}
                >
                  {t("bots.removeMember")}
                </Button>
              </li>
            ))}
          </ul>
          {room.members.length === 2 && (
            <p className="text-xs text-muted-foreground">{t("bots.roomTwoMin")}</p>
          )}
        </section>
        <section aria-label={t("bots.addToRoom")} className="flex flex-col gap-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("bots.addToRoom")}
          </h3>
          {addable.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("bots.noBotsToAdd")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {addable.map((bot) => (
                <li key={bot.id}>
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    aria-label={t("bots.addBotNamed", { name: bot.name })}
                    disabled={busy}
                    onClick={() => add.mutate({ conversationId, botId: bot.id })}
                  >
                    <BotAvatar name={bot.name} size={20} />
                    {bot.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {deleting ? (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3">
            <p className="text-sm font-medium">{t("bots.deleteRoomTitle", { name: room.name })}</p>
            <p className="text-xs text-muted-foreground">{t("bots.deleteRoomHint")}</p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeleting(false)}>
                {t("bots.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={destroy.isPending}
                onClick={() => destroy.mutate({ conversationId })}
              >
                {t("bots.confirmDeleteRoom")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <Button variant="outline" className="text-destructive" onClick={() => setDeleting(true)}>
            {t("bots.deleteRoom")}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
