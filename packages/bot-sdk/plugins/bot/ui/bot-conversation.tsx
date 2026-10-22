import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SendIcon } from "lucide-react";
import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";
import type { BotTurnProvenance } from "../shared/turn";
import { useBotTurn } from "../client/react/bot-turn";
import { useBotCheckIns } from "../client/react/check-ins";
import { useDemonstrationActions } from "../client/react/demonstrations";
import { allHelpers, useBotHelpers } from "../client/react/helpers";
import { useBotReviews } from "../client/react/reviews";
import { useBotRoutines } from "../client/react/routines";
import { useBotChoices } from "../client/react/choices";
import { useBotReactions } from "../client/react/reactions";
import { useBotSecrets } from "../client/react/secrets";
import { useCacheWarming } from "../client/react/warm";
import { BotAvatar } from "./bot-avatar";
import { ReactionBar, ReactionChips } from "./reactions";
import { CheckInLine } from "./check-in-line";
import { HelperCard } from "./helper-card";
import { isLiveHelper } from "../shared/helper";
import { ReviewPassesLine } from "./review-passes-line";
import { defaultRichControlRenderers, type RichControlRenderers } from "./rich-control";
import { RoutinesPopover } from "./routines-popover";
import { SecretsPopover } from "./secrets-popover";
import { RunDivider } from "./run-divider";
import { SummaryCard } from "./summary-card";
import { TodoPopover } from "./todo-popover";
import { WarmLine } from "./warm-line";

/**
 * A Bot's Conversation: the Messages sent in it, the user's on the right and the Bot's on the left,
 * ••• while a Turn runs, and "Seen ✓" under the user's last Message when the Bot stayed quiet, or "Couldn't reply" when the
 * Turn failed. A Routine the Bot created shows after the Turn that created it, as does a Check-in
 * it set, and each Helper it started shows as a card after it (a hand-off Message is followed by its Computer card), a Demonstration's Message is its Show me card, and each run of a Routine or fired Check-in gets a divider above what it sent, or one of its own when it stayed quiet. Where a Summary replaced the Bot's context, a card that expands to it sits before the next Message. The Bot's Messages are
 * never collapsed. The header lists the Routines, to pause, resume or delete them, and the To-do
 * list of live Helpers, to stop them. A Message's Rich control renders with the Host's renderer for
 * its kind in `controls`, or the default one.
 */
export function BotConversation({
  botId,
  headerEnd,
  afterTurn,
  controls,
}: {
  botId: string;
  /** Header buttons the Host adds after the Bot's own, such as the `memory` plugin's Memory popover. */
  headerEnd?: ReactNode;
  /**
   * What the Host shows under the last Bot Message a Turn sent, such as the `memory` plugin's
   * "Memory updated" chip. It may return nothing.
   */
  afterTurn?: (turn: BotTurnProvenance) => ReactNode;
  /** The Host's renderers for the Rich control kinds it draws itself. */
  controls?: RichControlRenderers;
}) {
  // One instance per Bot, so a Turn's state never shows on another Bot.
  return (
    <BotConversationView
      key={botId}
      botId={botId}
      headerEnd={headerEnd}
      afterTurn={afterTurn}
      controls={controls}
    />
  );
}

function BotConversationView({
  botId,
  headerEnd,
  afterTurn,
  controls,
}: {
  botId: string;
  headerEnd?: ReactNode;
  afterTurn?: (turn: BotTurnProvenance) => ReactNode;
  controls?: RichControlRenderers;
}) {
  const SecretCard = controls?.secret ?? defaultRichControlRenderers.secret;
  const ComputerCard = controls?.computer ?? defaultRichControlRenderers.computer;
  const ShowMeCard = controls?.demonstration ?? defaultRichControlRenderers.demonstration;
  const FilesCard = controls?.files ?? defaultRichControlRenderers.files;
  const ChoiceCard = controls?.choice ?? defaultRichControlRenderers.choice;
  const RoutineApproval =
    controls?.routine_approval ?? defaultRichControlRenderers.routine_approval;
  const ReviewApproval = controls?.review_approval ?? defaultRichControlRenderers.review_approval;
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState("");
  const {
    bot,
    error,
    messages,
    turns,
    summaries,
    warmings,
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

  const warmCache = useCacheWarming(botId);
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
  const {
    reviews,
    acting: actingReviews,
    allow: allowReview,
    deny: denyReview,
    // A live Helper's calls are reviewed too, while no Turn runs.
  } = useBotReviews(botId, working || helpers.some((helper) => isLiveHelper(helper.status)));
  const {
    secrets,
    acting: actingSecrets,
    save: saveSecret,
    remove: removeSecret,
  } = useBotSecrets(botId);
  const { acting: actingChoices, answer: answerChoice } = useBotChoices(botId);
  const { acting: actingReactions, react } = useBotReactions(botId);
  const { acting: actingDemonstrations, act: actOnDemonstration } = useDemonstrationActions(botId);
  const onDemonstration = (...args: Parameters<typeof actOnDemonstration>) =>
    void actOnDemonstration(...args).catch((refusal) =>
      toast.error(serverErrorText(i18n, refusal)),
    );
  const todo = helpers.filter((helper) => isLiveHelper(helper.status));
  const actions = { onPause: pause, onResume: resume, onDelete: remove, actingRoutines: acting };
  const checkInActions = { onCancelCheckIn, actingCheckIns };

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
  // Each Check-in under the Message its line follows; one whose Message isn't shown yet (its Turn
  // still runs here) follows the rest.
  const shownIds = new Set(messages.map((message) => message.id));
  // Only a Secret's newest request is a card: an older one is history, whatever happened since.
  const newestRequest = new Map<string, string>();
  for (const sent of messages)
    if (sent.control?.kind === "secret") newestRequest.set(sent.control.name, sent.id);
  // The same for a Routine's Approval: an edit sent it back to the user in a newer Message.
  const newestApproval = new Map<string, string>();
  for (const sent of messages)
    if (sent.control?.kind === "routine_approval")
      newestApproval.set(sent.control.routineId, sent.id);
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

  // Each warming call's line before the first Message saved after it ("" after the last).
  const warmingsBefore = new Map<string, ReactNode[]>();
  for (const warming of warmings) {
    const before = messages.find((message) => message.createdAt.getTime() >= warming.at.getTime());
    warmingsBefore.set(before?.id ?? "", [
      ...(warmingsBefore.get(before?.id ?? "") ?? []),
      <WarmLine key={warming.id} warming={warming} />,
    ]);
  }

  // Each Turn's passes line and `afterTurn` under the last Bot Message it sent: the last one saved
  // in its span. A Turn that sent none (quiet, or failed) has them under the last Message saved
  // before its end ("" with none), so its Steps still show.
  const afterTurnOf = new Map<string, ReactNode[]>();
  const passesOf = new Map<string, typeof reviews>();
  for (const review of reviews) {
    if (review.verdict !== "pass" || !review.turnId) continue;
    passesOf.set(review.turnId, [...(passesOf.get(review.turnId) ?? []), review]);
  }
  for (const [index, turn] of turns.entries()) {
    const from = turn.startedAt.getTime();
    // Up to its end, and never into the next Turn (a Turn that never ended has no end).
    const until = Math.min(
      turn.endedAt?.getTime() ?? Infinity,
      turns[index + 1]?.startedAt.getTime() ?? Infinity,
    );
    const before = messages.filter((message) => message.createdAt.getTime() <= until);
    const anchor =
      before
        .filter((message) => message.role === "assistant" && message.createdAt.getTime() >= from)
        .at(-1) ?? before.at(-1);
    const passes = passesOf.get(turn.id) ?? [];
    const shown = afterTurn?.(turn);
    const key = anchor?.id ?? "";
    if (passes.length > 0 || shown)
      afterTurnOf.set(key, [
        ...(afterTurnOf.get(key) ?? []),
        <Fragment key={turn.id}>
          {passes.length > 0 && <ReviewPassesLine passes={passes} />}
          {shown}
        </Fragment>,
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
          {secrets.length > 0 && (
            <SecretsPopover secrets={secrets} onDelete={removeSecret} acting={actingSecrets} />
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
        {messages.map(({ control, ...message }) => (
          <Fragment key={message.id}>
            {summariesBefore.get(message.id)}
            {warmingsBefore.get(message.id)}
            {runsBefore.get(message.id)}
            {control?.kind === "demonstration" ? (
              <ShowMeCard
                card={control}
                botName={bot.name}
                onAct={onDemonstration}
                acting={actingDemonstrations.has(control.demonstrationId)}
              />
            ) : control?.kind === "routine_approval" ||
              control?.kind === "review_approval" ? null : (
              <div
                className={cn(
                  "group relative flex max-w-[70%] flex-col gap-1",
                  message.role === "user" ? "self-end" : "self-start",
                )}
              >
                <div
                  data-bot-message
                  data-id={message.id}
                  data-role={message.role}
                  className={cn(
                    "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap",
                    message.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted",
                    message.pending && "opacity-70",
                  )}
                >
                  {message.text}
                </div>
                <ReactionChips
                  reactions={message.reactions}
                  own={message.role === "user" ? "user" : "bot"}
                />
                {message.role === "assistant" && !message.pending && (
                  <ReactionBar
                    current={message.reactions?.user?.emoji}
                    acting={actingReactions.has(message.id)}
                    onReact={(emoji) =>
                      void react(message.id, emoji).catch((refusal) =>
                        toast.error(serverErrorText(i18n, refusal)),
                      )
                    }
                  />
                )}
              </div>
            )}
            {message.channel === "email" && (
              <span className="self-end rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-900 dark:bg-sky-900 dark:text-sky-100">
                {t("bots.viaEmail")}
              </span>
            )}
            {afterTurnOf.get(message.id)}
            {control?.kind === "files" && <FilesCard card={control} />}
            {control?.kind === "choice" && (
              <ChoiceCard
                card={control}
                onAnswer={(answer) => answerChoice(message.id, answer)}
                acting={actingChoices.has(message.id)}
              />
            )}
            {control?.kind === "routine_approval" &&
              newestApproval.get(control.routineId) === message.id &&
              (() => {
                const routine = routines.find((found) => found.id === control.routineId);
                return (
                  routine && (
                    <RoutineApproval
                      routine={routine}
                      webhookToken={webhookTokens[routine.id]}
                      onApprove={approve}
                      onDecline={decline}
                      {...actions}
                    />
                  )
                );
              })()}
            {control?.kind === "review_approval" &&
              (() => {
                const review = reviews.find((found) => found.id === control.reviewId);
                return (
                  review && (
                    <ReviewApproval
                      review={review}
                      onAllow={allowReview}
                      onDeny={denyReview}
                      acting={actingReviews.has(review.id)}
                    />
                  )
                );
              })()}
            {control?.kind === "computer" && (
              <ComputerCard
                card={control}
                helper={helpers.find((helper) => helper.id === control.helperId)}
                onDone={onHelperDone}
                acting={actingHelpers.has(control.helperId)}
              />
            )}
            {control?.kind === "secret" && newestRequest.get(control.name) === message.id && (
              <SecretCard
                request={control}
                botName={bot.name}
                saved={secrets.some(
                  (saved) =>
                    saved.name === control.name &&
                    saved.createdAt.getTime() >= message.createdAt.getTime(),
                )}
                onSave={saveSecret}
                saving={actingSecrets.has(control.name)}
              />
            )}
            {message.id === seenMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.seen")}</p>
            )}
            {message.id === failedMessageId && (
              <p className="self-end text-xs text-muted-foreground">{t("bots.couldntReply")}</p>
            )}
            {checkInsAfter.get(message.id)?.map(checkInLine)}
            {helpersAfter.get(message.id)?.map(helperCard)}
          </Fragment>
        ))}
        {summariesBefore.get("")}
        {warmingsBefore.get("")}
        {runsBefore.get("")}
        {afterTurnOf.get("")}
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
          onChange={(event) => {
            // The first keystroke of a draft warms the cache while the user is still writing.
            if (!draft && event.target.value) warmCache();
            setDraft(event.target.value);
          }}
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
