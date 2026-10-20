import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SendIcon } from "lucide-react";
import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import type { BotTurnProvenance } from "../shared/turn";
import { useBackgroundRuns, useBotTurn } from "../client/react/bot-turn";
import { useBotCheckIns } from "../client/react/check-ins";
import { allHelpers, useBotHelpers } from "../client/react/helpers";
import { useBotRoutines } from "../client/react/routines";
import { BotAvatar } from "./bot-avatar";
import { CheckInLine } from "./check-in-line";
import { ComputerCard } from "./computer-card";
import { HelperCard } from "./helper-card";
import { isLiveHelper } from "../shared/helper";
import { RoutineCard } from "./routine-card";
import { RoutinesPopover } from "./routines-popover";
import { RunDivider } from "./run-divider";
import { SummaryCard } from "./summary-card";
import { TodoPopover } from "./todo-popover";

/**
 * A Bot's Conversation: the Messages sent in it, the user's on the right and the Bot's on the left,
 * ••• while a Turn runs, and "Seen ✓" under the user's last Message when the Bot stayed quiet, or "Couldn't reply" when the
 * Turn failed. A Routine the Bot created shows after the Turn that created it, as does a Check-in
 * it set, and each Helper it started shows as a card after it (a hand-off Message is followed by its Computer card), and each run of a Routine or fired Check-in gets a divider above what it sent, or one of its own when it stayed quiet. Where a Summary replaced the Bot's context, a card that expands to it sits before the next Message. The Bot's Messages are
 * never collapsed. The header lists the Routines, to pause, resume or delete them, and the To-do
 * list of live Helpers, to stop them.
 */
export function BotConversation({
  botId,
  headerEnd,
  afterTurn,
}: {
  botId: string;
  /** Header buttons the Host adds after the Bot's own, such as the `memory` plugin's Memory popover. */
  headerEnd?: ReactNode;
  /**
   * What the Host shows under the last Bot Message a Turn sent, such as the `memory` plugin's
   * "Memory updated" chip. It may return nothing.
   */
  afterTurn?: (turn: BotTurnProvenance) => ReactNode;
}) {
  // One instance per Bot, so a Turn's state never shows on another Bot.
  return (
    <BotConversationView key={botId} botId={botId} headerEnd={headerEnd} afterTurn={afterTurn} />
  );
}

function BotConversationView({
  botId,
  headerEnd,
  afterTurn,
}: {
  botId: string;
  headerEnd?: ReactNode;
  afterTurn?: (turn: BotTurnProvenance) => ReactNode;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState("");
  const {
    bot,
    error,
    messages,
    turns,
    summaries,
    working,
    seenMessageId,
    failedMessageId,
    send,
    stop,
  } = useBotTurn(botId, {
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
  const {
    helpers,
    acting: actingHelpers,
    stop: stopHelpers,
    done: helperDone,
  } = useBotHelpers(botId, working);
  const onStopHelper = (helperId?: string) =>
    void stopHelpers(helperId).catch((refusal) => toast.error(serverErrorText(i18n, refusal)));
  const onHelperDone = (helperId: string) =>
    void helperDone(helperId).catch((refusal) => toast.error(serverErrorText(i18n, refusal)));
  const todo = helpers.filter((helper) => isLiveHelper(helper.status));
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
  const helpersAfter = groupAfter(helpers, shownIds);
  const checkInLine = (checkIn: (typeof checkIns)[number]) => (
    <CheckInLine key={checkIn.id} checkIn={checkIn} {...checkInActions} />
  );
  const helperCard = (helper: (typeof helpers)[number]) => (
    <HelperCard
      key={helper.id}
      helper={helper}
      onStop={onStopHelper}
      stopping={actingHelpers.has(helper.id) || actingHelpers.has(allHelpers)}
    />
  );
  // Each run's divider, before the Message it goes above ("" after the last): a run that
  // sent something above its first Message, a quiet one where it ran. One still running and quiet
  // has none yet.
  const runsBefore = new Map<string, ReactNode[]>();
  for (const turn of turns) {
    // A Helper's report wakes a Turn too, but it shows on the Helper's card, not as a divider.
    const fired = turn.triggers.find(
      (trigger) => trigger.source !== "user" && trigger.source !== "helper",
    );
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

  // Each Summary's card before the first Message saved at or after it ("" after the last).
  const summariesBefore = new Map<string, ReactNode[]>();
  for (const summary of summaries) {
    const before =
      messages.find((message) => message.createdAt.getTime() >= summary.at.getTime())?.id ?? "";
    summariesBefore.set(before, [
      ...(summariesBefore.get(before) ?? []),
      <SummaryCard key={summary.id} summary={summary} />,
    ]);
  }

  // Each Turn's `afterTurn` under the last Bot Message it sent: the last one saved in its span.
  const afterTurnOf = new Map<string, ReactNode[]>();
  if (afterTurn) {
    for (const [index, turn] of turns.entries()) {
      const from = turn.startedAt.getTime();
      // Up to its end, and never into the next Turn (a Turn that never ended has no end).
      const until = Math.min(
        turn.endedAt?.getTime() ?? Infinity,
        turns[index + 1]?.startedAt.getTime() ?? Infinity,
      );
      const sent = messages
        .filter((message) => {
          const at = message.createdAt.getTime();
          return message.role === "assistant" && at >= from && at <= until;
        })
        .at(-1);
      const shown = sent && afterTurn(turn);
      if (shown)
        afterTurnOf.set(sent.id, [
          ...(afterTurnOf.get(sent.id) ?? []),
          <Fragment key={turn.id}>{shown}</Fragment>,
        ]);
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <BotAvatar name={bot.name} size={28} />
        <h1 className="font-semibold">{bot.name}</h1>
        <div className="ml-auto flex items-center gap-2">
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
          {todo.length > 0 && (
            <TodoPopover helpers={todo} onStop={onStopHelper} acting={actingHelpers} />
          )}
          {headerEnd}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="m-auto text-sm text-muted-foreground">{t("bots.noMessages")}</p>
        )}
        {messages.map((message) => (
          <Fragment key={message.id}>
            {summariesBefore.get(message.id)}
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
            {afterTurnOf.get(message.id)}
            {message.computer && (
              <ComputerCard
                card={message.computer}
                helper={helpers.find((helper) => helper.id === message.computer?.helperId)}
                onDone={onHelperDone}
                acting={actingHelpers.has(message.computer.helperId)}
              />
            )}
            {message.id === seenMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.seen")}</p>
            )}
            {message.id === failedMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.couldntReply")}</p>
            )}
            {routinesAfter.get(message.id)?.map(routineCard)}
            {checkInsAfter.get(message.id)?.map(checkInLine)}
            {helpersAfter.get(message.id)?.map(helperCard)}
          </Fragment>
        ))}
        {summariesBefore.get("")}
        {runsBefore.get("")}
        {routinesAfter.get("")?.map(routineCard)}
        {checkInsAfter.get("")?.map(checkInLine)}
        {helpersAfter.get("")?.map(helperCard)}
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
