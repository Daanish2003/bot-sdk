import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CrownIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { useRooms } from "@botsdk/react/bot/rooms";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { BotAvatar } from "./bot-avatar";

/** The sidebar's Rooms (spec #1055), under the Bots: each Room, and "+ New Room". */
export function RoomsNav({ bots }: { bots: { id: string; name: string }[] }) {
  const { Link } = useChatAdapter();
  const { t } = useI18n();
  const rooms = useRooms();
  const [creating, setCreating] = useState(false);
  return (
    <nav aria-label={t("bots.rooms")} className="border-t">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("bots.rooms")}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("bots.newRoom")}
          title={t("bots.newRoom")}
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
        </Button>
      </div>
      <ul>
        {rooms.data?.map((room) => (
          <li key={room.conversationId}>
            <Link
              page={{ to: "rooms", id: room.conversationId }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted"
              activeClassName="bg-muted"
            >
              <span className="relative h-8 w-9 shrink-0">
                {room.members.slice(0, 2).map((member, index) => (
                  <span
                    key={member.botId}
                    className="absolute"
                    style={{ left: index * 10, top: index * 6 }}
                  >
                    <BotAvatar name={member.name} size={22} />
                  </span>
                ))}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{room.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {t("bots.roomBots", { count: room.members.length })}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {rooms.data?.length === 0 && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">{t("bots.noRooms")}</p>
      )}
      <NewRoomDialog bots={bots} open={creating} onOpenChange={setCreating} />
    </nav>
  );
}

/**
 * "+ New Room": a name and two or more of the user's Bots, in the order picked; the first picked
 * leads. The new Room opens straight away.
 */
export function NewRoomDialog({
  bots,
  open,
  onOpenChange,
}: {
  bots: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { orpc, navigate } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);

  // Closing the dialog, however it closes, starts the next one afresh.
  const close = () => {
    onOpenChange(false);
    setName("");
    setPicked([]);
  };
  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((each) => each !== id) : [...prev, id]));

  const create = useMutation(
    orpc.rooms.create.mutationOptions({
      onSuccess: async (created) => {
        // The new Room has the newest activity, so it goes first.
        queryClient.setQueryData(orpc.rooms.list.queryKey(), (rooms) => [
          created,
          ...(rooms ?? []),
        ]);
        close();
        await navigate({ to: "rooms", id: created.conversationId });
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );

  const ready = name.trim() !== "" && picked.length >= 2 && !create.isPending;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) create.mutate({ name: name.trim(), botIds: picked });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("bots.newRoom")}</DialogTitle>
          <DialogDescription>{t("bots.newRoomHint")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            autoFocus
            aria-label={t("bots.roomName")}
            placeholder={t("bots.roomName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
          />
          <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
            {bots.map((bot) => {
              const index = picked.indexOf(bot.id);
              return (
                <li key={bot.id}>
                  <button
                    type="button"
                    aria-pressed={index >= 0}
                    onClick={() => toggle(bot.id)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left",
                      index >= 0 ? "border-primary bg-primary/5" : "hover:bg-muted",
                    )}
                  >
                    <BotAvatar name={bot.name} size={26} />
                    <span className="flex-1 truncate text-sm">{bot.name}</span>
                    {index === 0 && (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                        <CrownIcon className="size-3" />
                        {t("bots.lead")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          <Button type="submit" disabled={!ready}>
            {t("bots.createRoom")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
