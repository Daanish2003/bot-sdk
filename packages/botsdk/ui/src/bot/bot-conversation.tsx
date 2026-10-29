import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { SentFile } from "@botsdk/client/bot/files";
import { isLiveHelper } from "@botsdk/client/bot/helper";
import { isApproval } from "@botsdk/client/bot/rich-control";
import type { BotTurnProvenance } from "@botsdk/client/bot/turn";
import { SendIcon } from "lucide-react";
import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorData, serverErrorText } from "@botsdk/react/rpc-error";
import { useBotTurn } from "@botsdk/react/bot/bot-turn";
import { useBotCheckIns } from "@botsdk/react/bot/check-ins";
import { useDemonstrationActions } from "@botsdk/react/bot/demonstrations";
import { allHelpers, useBotHelpers } from "@botsdk/react/bot/helpers";
import { useBotReviews } from "@botsdk/react/bot/reviews";
import { useCustomRules } from "@botsdk/react/bot/rules";
import { useBotRoutines } from "@botsdk/react/bot/routines";
import { useBotPause } from "@botsdk/react/bot/pause";
import { useBotTasks, useSkipTrigger } from "@botsdk/react/bot/tasks";
import { useBotChoices } from "@botsdk/react/bot/choices";
import { useBotReactions } from "@botsdk/react/bot/reactions";
import { useBotUploads } from "@botsdk/react/bot/uploads";
import { useBotSecrets } from "@botsdk/react/bot/secrets";
import { useCacheWarming } from "@botsdk/react/bot/warm";
import { BotAvatar } from "./bot-avatar";
import { BotMenu, PausedBadge, PausedBanner } from "./bot-menu";
import { AttachButton, DraftFileChips } from "./draft-files";
import { ReactionBar, ReactionChips } from "./reactions";
import { CheckInLine } from "./check-in-line";
import { HelperCard } from "./helper-card";
import { NeverAllowedLine } from "./never-allowed-line";
import { ReviewPassesLine } from "./review-passes-line";
import { defaultRichControlRenderers, type RichControlRenderers } from "./rich-control";
import { SecretsPopover } from "./secrets-popover";
import { RunDivider } from "./run-divider";
import { SummaryCard } from "./summary-card";
import { TasksPopover } from "./tasks-popover";
import { WarmLine } from "./warm-line";

/**
 * A Bot's Conversation: the Messages sent in it, the user's on the right and the Bot's on the left,
 * ••• while a Turn runs, and "Seen ✓" under the user's last Message when the Bot stayed quiet, or "Couldn't reply" when the
 * Turn failed. A Routine the Bot created shows after the Turn that created it, as does a Check-in
 * it set, and each Helper it started shows as a card after it (a hand-off Message is followed by its Computer card), a Demonstration's Message is its Show me card, and each run of a Routine or fired Check-in gets a divider above what it sent, or one of its own when it stayed quiet. Where a Summary replaced the Bot's context, a card that expands to it sits before the next Message. The Bot's Messages are
 * never collapsed. The header's Tasks view lists what the Bot is doing, what is scheduled and what
 * is done, with the controls to stop, pause, resume, delete and cancel. A Message's Rich control renders with the Host's renderer for
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

/** The files a refused send named as no longer uploaded: all of them when it names none. */
function goneFiles(refusal: unknown, files: SentFile[]): Set<string> {
  const data = serverErrorData(refusal);
  if (data?.code !== "error.botFileNotFound") return new Set();
  const { missing } = data as { missing?: unknown };
  return new Set(Array.isArray(missing) ? missing.map(String) : files.map((file) => file.id));
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
  const RuleApproval = controls?.rule_approval ?? defaultRichControlRenderers.rule_approval;
  const i18n = useI18n();
  const { t } = i18n;
  const [draft, setDraft] = useState("");
  const uploads = useBotUploads();
  const [dragging, setDragging] = useState(false);
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
    // A refused send puts its text back in the composer and says why. Its files come back too,
    // except the ones no longer uploaded (swept, or taken by an earlier send): the user attaches
    // them again, as the refusal says.
    onRefusedSend: (text, refusal, files) => {
      setDraft(text);
      uploads.restore(files.filter((file) => !goneFiles(refusal, files).has(file.id)));
      toast.error(serverErrorText(i18n, refusal));
    },
  });

  const warmCache = useCacheWarming(botId);
  const {
    routines,
    webhookTokens,
    acting,
    approve,
    decline,
    pause,
    resume,
    remove,
    rotate,
    edit: editRoutine,
  } = useBotRoutines(botId, working);
  const {
    checkIns,
    acting: actingCheckIns,
    cancel: onCancelCheckIn,
    edit: editCheckIn,
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
  const customRules = useCustomRules();
  const { acting: actingChoices, answer: answerChoice } = useBotChoices(botId);
  const { acting: actingReactions, react } = useBotReactions(botId);
  const { acting: actingDemonstrations, act: actOnDemonstration } = useDemonstrationActions(botId);
  const onDemonstration = (...args: Parameters<typeof actOnDemonstration>) =>
    void actOnDemonstration(...args).catch((refusal) =>
      toast.error(serverErrorText(i18n, refusal)),
    );
  const { tasks } = useBotTasks(botId, working);
  const { actingTriggers, skip: onSkipTrigger } = useSkipTrigger(botId);
  const botPause = useBotPause(botId);
  const onPauseBot = () =>
    void botPause.pause().catch((refusal) => toast.error(serverErrorText(i18n, refusal)));
  const onResumeBot = () =>
    void botPause.resume().catch((refusal) => toast.error(serverErrorText(i18n, refusal)));
  const onStopTurn = () =>
    void stop().catch((refusal) => toast.error(serverErrorText(i18n, refusal)));
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
  // A paused Bot takes no Message (spec #1007): the composer is disabled under its banner.
  const paused = Boolean(bot.pausedAt);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    // Send waits for the uploads; with files the text may be empty.
    if (paused || (!text && uploads.uploaded.length === 0) || uploads.pending) return;
    const files = uploads.uploaded;
    setDraft("");
    uploads.clear();
    void send(text, files);
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
    // A Helper's report wakes a Turn too, but it shows on the Helper's card, not as a divider, as
    // a late Approval's answer shows on its card.
    const fired = turn.triggers.find(
      (trigger) =>
        trigger.source !== "user" && trigger.source !== "helper" && trigger.source !== "approval",
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
  const neversOf = new Map<string, typeof reviews>();
  for (const review of reviews) {
    if (!review.turnId) continue;
    const into =
      review.verdict === "pass" ? passesOf : review.verdict === "never" ? neversOf : null;
    into?.set(review.turnId, [...(into.get(review.turnId) ?? []), review]);
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
    const nevers = neversOf.get(turn.id) ?? [];
    const shown = afterTurn?.(turn);
    const key = anchor?.id ?? "";
    if (passes.length > 0 || nevers.length > 0 || shown)
      afterTurnOf.set(key, [
        ...(afterTurnOf.get(key) ?? []),
        <Fragment key={turn.id}>
          {passes.length > 0 && <ReviewPassesLine passes={passes} />}
          {nevers.map((review) => (
            <NeverAllowedLine key={review.id} review={review} />
          ))}
          {shown}
        </Fragment>,
      ]);
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <section
      data-dragging={dragging || undefined}
      className="flex min-h-0 min-w-0 flex-1 flex-col data-[dragging]:ring-2 data-[dragging]:ring-ring data-[dragging]:ring-inset"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        uploads.add(event.dataTransfer.files);
      }}
    >
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <BotAvatar name={bot.name} size={28} />
        <h1 className="font-semibold">{bot.name}</h1>
        {paused && <PausedBadge />}
        <div className="ml-auto flex items-center gap-2">
          {tasks && (
            <TasksPopover
              tasks={tasks}
              onStopTurn={onStopTurn}
              onStopHelper={onStopHelper}
              actingHelpers={actingHelpers}
              {...checkInActions}
              onSkipTrigger={onSkipTrigger}
              actingTriggers={actingTriggers}
              webhookTokens={webhookTokens}
              onRotate={rotate}
              onEditRoutine={editRoutine}
              onEditCheckIn={editCheckIn}
              {...actions}
            />
          )}
          {secrets.length > 0 && (
            <SecretsPopover secrets={secrets} onDelete={removeSecret} acting={actingSecrets} />
          )}
          {headerEnd}
          <BotMenu
            paused={paused}
            acting={botPause.acting}
            onPause={onPauseBot}
            onResume={onResumeBot}
          />
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
            ) : isApproval(control?.kind) ? null : (
              <div
                className={cn(
                  "group relative flex max-w-[70%] flex-col gap-1",
                  message.role === "user" ? "self-end" : "self-start",
                )}
              >
                {(message.text || control?.kind !== "files") && (
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
                )}
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
              <span
                data-channel-pill
                className={cn(
                  "rounded-full bg-sky-100 px-2 py-0.5 text-[10px] text-sky-900 dark:bg-sky-900 dark:text-sky-100",
                  message.role === "user" ? "self-end" : "self-start",
                )}
              >
                {t(message.role === "user" ? "bots.viaEmail" : "bots.emailed")}
              </span>
            )}
            {afterTurnOf.get(message.id)}
            {control?.kind === "files" && (
              <FilesCard
                card={control}
                className={message.role === "user" ? "self-end" : undefined}
              />
            )}
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
            {control?.kind === "rule_approval" &&
              (() => {
                const rule = customRules.rules.find((found) => found.id === control.ruleId);
                return (
                  rule && (
                    <RuleApproval
                      rule={rule}
                      onApprove={customRules.approve}
                      onDeny={customRules.deny}
                      acting={customRules.acting.has(rule.id)}
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
      <DraftFileChips uploads={uploads} />
      {paused && <PausedBanner acting={botPause.acting} onResume={onResumeBot} />}
      <form onSubmit={submit} className="flex items-end gap-2 border-t p-3">
        <AttachButton uploads={uploads} disabled={paused} />
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
          disabled={paused}
          rows={1}
          className="max-h-40 min-h-10 resize-none"
        />
        {working && (
          <Button type="button" variant="outline" onClick={onStopTurn}>
            ■ {t("bots.stop")}
          </Button>
        )}
        <Button
          type="submit"
          size="icon"
          aria-label={t("bots.send")}
          disabled={paused || (!draft.trim() && uploads.uploaded.length === 0) || uploads.pending}
        >
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
