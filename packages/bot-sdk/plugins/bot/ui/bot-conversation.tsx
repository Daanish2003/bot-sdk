import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SendIcon } from "lucide-react";
import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import { useBackgroundRuns, useBotTurn } from "../client/react/bot-turn";
import { useBotCheckIns } from "../client/react/check-ins";
import { useBotRoutines } from "../client/react/routines";
import { BotAvatar } from "./bot-avatar";
import { CheckInLine } from "./check-in-line";
import { RoutineCard } from "./routine-card";
import { RoutinesPopover } from "./routines-popover";
import { RunDivider } from "./run-divider";

/**
 * A Bot's Conversation: the Messages sent in it, the user's on the right and the Bot's on the left,
 * ••• while a Turn runs, and "Seen ✓" under the user's last Message when the Bot stayed quiet, or "Couldn't reply" when the
 * Turn failed. A Routine the Bot created shows after the Turn that created it, as does a Check-in
 * it set, and each run of a Routine or fired Check-in gets a divider above what it sent, or one of its own when it stayed quiet. The Bot's Messages are
 * never collapsed. The header lists the Routines, to pause, resume or delete them.
 */
export function BotConversation({ botId }: { botId: string }) {
  // One instance per Bot, so a Turn's state never shows on another Bot.
  return <BotConversationView key={botId} botId={botId} />;
}

function BotConversationView({ botId }: { botId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState("");
  const { bot, error, messages, turns, working, seenMessageId, failedMessageId, send, stop } =
    useBotTurn(botId, {
      // A refused send puts its text back in the composer and says why.
      onRefusedSend: (text, refusal) => {
        setDraft(text);
        toast.error(serverErrorText(i18n, refusal));
      },
    });

  const { routines, webhookTokens, acting, approve, decline, pause, resume, remove, rotate } =
    useBotRoutines(botId, working);
  const {
    checkIns,
    acting: actingCheckIns,
    cancel: onCancelCheckIn,
  } = useBotCheckIns(botId, working);
  const actions = { onPause: pause, onResume: resume, onDelete: remove, actingRoutines: acting };
  const checkInActions = { onCancelCheckIn, actingCheckIns };
  useBackgroundRuns(
    botId,
    !working &&
      (routines.some((routine) => routine.state === "active") ||
        checkIns.some((checkIn) => checkIn.state === "pending")),
  );

  if (error) {
    return (
      <p className="m-auto p-4 text-sm text-muted-foreground">
        {serverErrorText(i18n, error, "error.botNotFound")}
      </p>
    );
  }
  if (!bot) return null;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void send(text);
  };
  const routineCard = (routine: (typeof routines)[number]) => (
    <RoutineCard
      key={routine.id}
      routine={routine}
      webhookToken={webhookTokens[routine.id]}
      onApprove={approve}
      onDecline={decline}
      {...actions}
    />
  );
  // Each Routine under the Message its card follows, and each Check-in under the one its line
  // follows; one whose Message isn't shown yet (its Turn still runs here) follows the rest.
  const shownIds = new Set(messages.map((message) => message.id));
  const routinesAfter = groupAfter(routines, shownIds);
  const checkInsAfter = groupAfter(checkIns, shownIds);
  const checkInLine = (checkIn: (typeof checkIns)[number]) => (
    <CheckInLine key={checkIn.id} checkIn={checkIn} {...checkInActions} />
  );
  // Each run's divider, before the Message it goes above ("" after the last): a run that
  // sent something above its first Message, a quiet one where it ran. One still running and quiet
  // has none yet.
  const runsBefore = new Map<string, ReactNode[]>();
  for (const turn of turns) {
    const fired = turn.triggers.find((trigger) => trigger.source !== "user");
    if (!fired) continue;
    const from = turn.startedAt.getTime();
    const until = turn.endedAt?.getTime() ?? Infinity;
    const quiet = !turn.sent;
    if (quiet && turn.status !== "complete") continue;
    const next = messages.find((message) => {
      const at = message.createdAt.getTime();
      return quiet ? at >= from : message.role === "assistant" && at >= from && at <= until;
    });
    const before = next?.id ?? "";
    runsBefore.set(before, [
      ...(runsBefore.get(before) ?? []),
      <RunDivider
        key={turn.id}
        name={fired.source === "check_in" ? t("bots.checkIn") : (fired.routineName ?? "")}
        at={fired.at}
        quiet={quiet}
        webhook={fired.channel === "webhook"}
      />,
    ]);
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <BotAvatar name={bot.name} size={28} />
        <h1 className="font-semibold">{bot.name}</h1>
        {(routines.length > 0 || checkIns.some((checkIn) => checkIn.state === "pending")) && (
          <RoutinesPopover
            routines={routines}
            checkIns={checkIns}
            {...checkInActions}
            webhookTokens={webhookTokens}
            onRotate={rotate}
            {...actions}
          />
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="m-auto text-sm text-muted-foreground">{t("bots.noMessages")}</p>
        )}
        {messages.map((message) => (
          <Fragment key={message.id}>
            {runsBefore.get(message.id)}
            <div
              data-bot-message
              data-id={message.id}
              data-role={message.role}
              className={cn(
                "max-w-[70%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                message.role === "user"
                  ? "self-end bg-primary text-primary-foreground"
                  : "self-start bg-muted",
                message.pending && "opacity-70",
              )}
            >
              {message.text}
            </div>
            {message.id === seenMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.seen")}</p>
            )}
            {message.id === failedMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.couldntReply")}</p>
            )}
            {routinesAfter.get(message.id)?.map(routineCard)}
            {checkInsAfter.get(message.id)?.map(checkInLine)}
          </Fragment>
        ))}
        {runsBefore.get("")}
        {routinesAfter.get("")?.map(routineCard)}
        {checkInsAfter.get("")?.map(checkInLine)}
        {working && (
          <div
            role="status"
            aria-label={t("bots.typing")}
            className="self-start rounded-2xl bg-muted px-3 py-2 text-sm tracking-widest text-muted-foreground"
          >
            •••
          </div>
        )}
      </div>
      <form onSubmit={submit} className="flex items-end gap-2 border-t p-3">
        <Textarea
          aria-label={t("bots.message")}
          placeholder={t("bots.message")}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          className="max-h-40 min-h-10 resize-none"
        />
        {working && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void stop().catch((refusal) => toast.error(serverErrorText(i18n, refusal)))
            }
          >
            ■ {t("bots.stop")}
          </Button>
        )}
        <Button type="submit" size="icon" aria-label={t("bots.send")} disabled={!draft.trim()}>
          <SendIcon />
        </Button>
      </form>
    </section>
  );
}

/** `items` by the Message each follows, in order: "" for those whose Message isn't in `shownIds`. */
function groupAfter<T extends { afterMessageId: string | null }>(
  items: T[],
  shownIds: ReadonlySet<string>,
): Map<string, T[]> {
  const after = new Map<string, T[]>();
  for (const item of items) {
    const id = item.afterMessageId && shownIds.has(item.afterMessageId) ? item.afterMessageId : "";
    after.set(id, [...(after.get(id) ?? []), item]);
  }
  return after;
}
