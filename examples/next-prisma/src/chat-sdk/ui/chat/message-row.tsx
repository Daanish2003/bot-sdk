import type { AttachmentInfo } from "../../core/shared/attachments/kinds";
import { createArtifactToolName, updateArtifactToolName } from "../../core/shared/chat/artifact";
import { pageSourcesOf, replySegments, sourcesOf } from "../../core/shared/chat/sources";
import { generatedImageOf } from "../../core/shared/chat/generated-image";
import { toolCallOf, type ToolCallView } from "../../core/shared/chat/tool-call";
import { webSearchOf } from "../../core/shared/chat/web-search";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/prompt-kit/loader";
import { Markdown } from "@/components/ui/prompt-kit/markdown";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ui/prompt-kit/reasoning";
import { SystemMessage } from "@/components/ui/prompt-kit/system-message";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { UIMessage } from "@tanstack/ai-react";
import {
  BotIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  UserIcon,
} from "lucide-react";
import { Fragment, useState } from "react";

import {
  describeError,
  messageAttachments,
  messageSiblings,
  messageInfo,
  type MessageInfo,
} from "../../core/client/chat";
import { modelLabel } from "../../core/client/models";

import {
  AttachButton,
  AttachmentChips,
  DraftAttachmentChips,
  useAttachmentDraft,
} from "./attachments";

import { type EditSource, GeneratedImageBlock } from "./generated-image-block";
import { ReadAloud } from "./read-aloud";
import { ArtifactCard, artifactIdOf, type ArtifactRef } from "./artifact-card";
import { SearchRow } from "./search-row";
import { replyComponents, ReplySources, SourceChips } from "./source-chips";
import { ToolCallRow } from "./tool-call-row";
import { UsageInfo } from "./usage-info";

import { useByok } from "../../core/client/react/byok";
import { useChatAdapter, useI18n } from "../../core/client/react/provider";

function plainText(message: UIMessage) {
  return message.parts.map((part) => (part.type === "text" ? part.content : "")).join("");
}

/** The model's thinking; a redacted block has no text to show. */
function thinkingText(message: UIMessage) {
  return message.parts
    .map((part) => (part.type === "thinking" ? part.content : ""))
    .filter(Boolean)
    .join("\n\n");
}

type MessageActions = {
  /** A reply is streaming in this Conversation. */
  streaming: boolean;
  /** The selected Model, which decides the files an edit can add. */
  model: string;
  /**
   * Sends the edited text as a new Branch beside this user Message, with the attachments the
   * user kept and added.
   */
  onEdit: (text: string, attachments: AttachmentInfo[]) => void;
  /** Asks for a new reply beside this assistant Message. */
  onRegenerate: () => void;
  /** Shows the Branch through this sibling. */
  onSwitchBranch: (messageId: string) => void;
  /**
   * Answers the call this reply waits on: approve (`true`) or deny (ADR 0008). An approval with
   * `allowForConversation` also allows the tool for the Conversation (#159).
   */
  onDecide?: (approved: boolean, allowForConversation?: boolean) => void;
  /**
   * Sets this reply's Rating (`up` or `down`), or clears it with null. Only offered on an ended
   * reply (see `ratableStatuses`).
   */
  onRate: (rating: "up" | "down" | null) => void;
};

/** The statuses whose Run has ended: only their replies can be rated (CONTEXT.md, **Rating**). */
const ratableStatuses = new Set(["complete", "stopped", "error"]);

/**
 * One full-width Message row: avatar, header with the ‹ n/m › Branch arrows, then the text
 * (Markdown for the assistant). Hovering shows Copy, and Edit (user) or Regenerate (assistant).
 * While a reply streams, those and the arrows are disabled. Without `actions` (a Shared link's
 * read-only page) the row has neither. `userLabel` names the user's Messages ("You" in the
 * user's own Conversation).
 */
export function MessageRow({
  message,
  userLabel,
  actions,
  highlighted = false,
  contextCut = false,
  imagesUrl,
  editSources,
  onOpenArtifact,
  latestVersionOf,
}: {
  message: UIMessage;
  userLabel?: string;
  actions?: MessageActions;
  /** Marks the row as the search hit just opened. */
  highlighted?: boolean;
  /** The Model's context starts at this Message on the Branch: a marker sits above it. */
  contextCut?: boolean;
  /** Where a Generated image's bytes come from; the owner's route when unset (a Shared link passes its own). */
  imagesUrl?: string;
  /** The images on the Branch an edit can start from, by id (`editSourcesOf`). */
  editSources?: ReadonlyMap<string, EditSource>;
  /** Opens an Artifact's card in the side panel (spec #304). */
  onOpenArtifact?: (ref: ArtifactRef) => void;
  /** The newest version of an Artifact on the Branch, which an update's card names (spec #304). */
  latestVersionOf?: (artifactId: string) => number | undefined;
}) {
  const { locale, t } = useI18n();
  const info = messageInfo(message);
  const text = plainText(message);
  const thinking = thinkingText(message);
  const attachments = messageAttachments(message);
  const isUser = message.role === "user";
  const model = info.model ? modelLabel(info.model) : null;
  const [editing, setEditing] = useState(false);

  return (
    <div
      data-message-id={message.id}
      className={cn(
        "group border-b border-border/50 px-4 py-4 transition-colors duration-500 sm:px-6",
        isUser && "bg-muted/30",
        highlighted && "bg-primary/10 ring-1 ring-primary/40 ring-inset",
      )}
    >
      {contextCut && (
        <p className="mx-auto mb-3 flex w-full max-w-4xl items-center gap-3 text-[11px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" aria-hidden />
          {t("chat.contextCut")}
          <span className="h-px flex-1 bg-border" aria-hidden />
        </p>
      )}
      <div className="mx-auto flex w-full max-w-4xl gap-3">
        <div
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            isUser ? "bg-secondary" : "bg-primary/15 text-primary",
          )}
        >
          {isUser ? <UserIcon className="size-3.5" /> : <BotIcon className="size-3.5" />}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex min-h-6 flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">
              {isUser ? (userLabel ?? t("chat.you")) : t("chat.assistant")}
            </span>
            {!isUser && model && (
              <span className="rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {model}
              </span>
            )}
            {message.createdAt && (
              <time
                className="text-[10px] text-muted-foreground"
                dateTime={message.createdAt.toISOString()}
              >
                {message.createdAt.toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            )}
            {!isUser && (info.usage || info.reasoningEffort) && (
              <UsageInfo usage={info.usage} reasoningEffort={info.reasoningEffort} />
            )}
            {actions && (
              <BranchArrows
                message={message}
                disabled={actions.streaming}
                onSwitch={actions.onSwitchBranch}
              />
            )}
            {!editing && actions && (
              <div
                className={cn(
                  "ml-auto flex overflow-hidden rounded-md border bg-background shadow-sm group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
                  // A Rating stays visible, so the thumb that was chosen is still filled.
                  info.rating ? "opacity-100" : "opacity-0",
                )}
              >
                {/* A Hidden reply's text is gone, so it can't be copied or read aloud (#268). */}
                {!info.hidden && <CopyButton text={text} disabled={actions.streaming} />}
                {!isUser && !info.hidden && info.status === "complete" && (
                  <ReadAloud messageId={message.id} parts={message.parts} />
                )}
                {!isUser && !info.hidden && ratableStatuses.has(info.status) && (
                  <RatingButtons
                    rating={info.rating}
                    disabled={actions.streaming}
                    onRate={actions.onRate}
                  />
                )}
                {isUser ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={actions.streaming}
                    onClick={() => setEditing(true)}
                    title={t("chat.editNewBranch")}
                    aria-label={t("chat.edit")}
                  >
                    <PencilIcon />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={actions.streaming}
                    onClick={actions.onRegenerate}
                    title={t("chat.regenerateNewBranch")}
                    aria-label={t("chat.regenerate")}
                  >
                    <RefreshCwIcon />
                  </Button>
                )}
              </div>
            )}
          </div>
          {editing && actions ? (
            <EditBox
              initial={text}
              initialAttachments={attachments.flatMap(({ id, size, ...chip }) =>
                id !== undefined && size !== undefined ? [{ id, size, ...chip }] : [],
              )}
              model={actions.model}
              onCancel={() => setEditing(false)}
              onSave={(edited, kept) => {
                setEditing(false);
                actions.onEdit(edited, kept);
              }}
              saveDisabled={actions.streaming}
            />
          ) : isUser ? (
            <>
              <AttachmentChips attachments={attachments} />
              <p className="max-w-[80ch] text-sm whitespace-pre-wrap">{text}</p>
            </>
          ) : info.hidden ? (
            <p className="text-xs text-muted-foreground italic">This reply was hidden</p>
          ) : (
            <>
              {thinking && (
                <Thinking text={thinking} inProgress={info.status === "streaming" && !text} />
              )}
              <AssistantParts
                messageId={message.id}
                parts={message.parts}
                onDecide={actions?.onDecide}
                imagesUrl={imagesUrl}
                editSources={editSources}
                onOpenArtifact={onOpenArtifact}
                latestVersionOf={latestVersionOf}
              />
              {info.status === "streaming" && !thinking && waitingForText(message.parts) && (
                <Loader variant="typing" size="sm" label={t("chat.loading")} />
              )}
              {info.status === "stopped" && (
                <span className="text-xs text-muted-foreground italic">{t("chat.stopped")}</span>
              )}
              {info.status === "error" && <ErrorMessage info={info} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The model's thinking as a collapsed "Thought for…" block (prompt-kit Reasoning). It opens while
 * the model is still thinking and folds away once the answer starts.
 */
function Thinking({ text, inProgress }: { text: string; inProgress: boolean }) {
  const { t } = useI18n();
  // No duration is stored, so the label stays approximate (as in the prototype).
  return (
    <Reasoning isStreaming={inProgress} className="max-w-[80ch]">
      <ReasoningTrigger className="text-xs text-muted-foreground">
        {inProgress ? t("chat.thinking") : t("chat.thoughtAFewSeconds")}
      </ReasoningTrigger>
      <ReasoningContent markdown className="mt-2 border-l-2 pl-3 text-xs">
        {text}
      </ReasoningContent>
    </Reasoning>
  );
}

/** ‹ n/m › between a Message's siblings; nothing when it has none. */
function BranchArrows({
  message,
  disabled,
  onSwitch,
}: {
  message: UIMessage;
  disabled: boolean;
  onSwitch: (messageId: string) => void;
}) {
  const { t } = useI18n();
  const { index, count, previousId, nextId } = messageSiblings(message);
  if (count < 2) return null;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled || !previousId}
        onClick={() => previousId && onSwitch(previousId)}
        aria-label={t("chat.previousBranch")}
      >
        <ChevronLeftIcon />
      </Button>
      {index + 1}/{count}
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled || !nextId}
        onClick={() => nextId && onSwitch(nextId)}
        aria-label={t("chat.nextBranch")}
      >
        <ChevronRightIcon />
      </Button>
    </span>
  );
}

/**
 * 👍 and 👎 on an ended reply. Clicking the chosen thumb clears the Rating; clicking the other one
 * flips it (CONTEXT.md, **Rating**).
 */
function RatingButtons({
  rating,
  disabled,
  onRate,
}: {
  rating: "up" | "down" | null;
  disabled: boolean;
  onRate: (rating: "up" | "down" | null) => void;
}) {
  const { t } = useI18n();
  const choose = (thumb: "up" | "down") => onRate(rating === thumb ? null : thumb);
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        onClick={() => choose("up")}
        title={t("chat.goodReply")}
        aria-label={t("chat.goodReply")}
        aria-pressed={rating === "up"}
      >
        <ThumbsUpIcon className={cn(rating === "up" && "fill-current")} />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={disabled}
        onClick={() => choose("down")}
        title={t("chat.badReply")}
        aria-label={t("chat.badReply")}
        aria-pressed={rating === "down"}
      >
        <ThumbsDownIcon className={cn(rating === "down" && "fill-current")} />
      </Button>
    </>
  );
}

function CopyButton({ text, disabled }: { text: string; disabled: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={t("chat.copy")}
      aria-label={t("chat.copy")}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/**
 * Inline edit of a user Message: Enter or Save & submit sends it, Escape cancels. The Message's
 * attachments are carried over; the user can remove them or add more.
 */
function EditBox({
  initial,
  initialAttachments,
  model,
  onSave,
  onCancel,
  saveDisabled,
}: {
  initial: string;
  initialAttachments: AttachmentInfo[];
  model: string;
  onSave: (text: string, attachments: AttachmentInfo[]) => void;
  onCancel: () => void;
  saveDisabled: boolean;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const draft = useAttachmentDraft(model, initialAttachments);
  const canSave = !saveDisabled && !draft.pending && value.trim().length > 0;
  const save = () => canSave && onSave(value.trim(), draft.uploaded);
  return (
    <div className="flex max-w-[80ch] flex-col gap-2 rounded-xl border bg-card p-2">
      <DraftAttachmentChips draft={draft} />
      <Textarea
        autoFocus
        aria-label={t("chat.editMessage")}
        className="min-h-12 border-none bg-transparent text-sm md:text-sm dark:bg-transparent"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save();
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto">
          <AttachButton draft={draft} />
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("chat.cancel")}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={save}>
          {t("chat.saveAndSubmit")}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">{t("chat.saveCreatesBranch")}</p>
    </div>
  );
}

/** The newest version on the Branch of the Artifact an update call names; `undefined` for a create. */
function artifactTarget(
  call: ToolCallView,
  latestVersionOf?: (artifactId: string) => number | undefined,
): number | undefined {
  const artifactId = artifactIdOf(call);
  return artifactId === undefined ? undefined : latestVersionOf?.(artifactId);
}

/**
 * A reply's text and web searches, in stream order. Back-to-back searches share one row; links
 * to the reply's Sources render as their numbered citation chips.
 */
/**
 * The images a Branch's Messages hold, by id, for an edit's "edited from" chip (spec #278). A
 * finished Generated image is labelled by its prompt; an image Attachment by its file name.
 */
export function editSourcesOf(messages: UIMessage[]): Map<string, EditSource> {
  const sources = new Map<string, EditSource>();
  for (const message of messages) {
    for (const part of message.parts) {
      const image = generatedImageOf(part);
      if (image?.state === "done" && image.imageId) {
        sources.set(image.imageId, { label: image.prompt, imageId: image.imageId });
      }
    }
    for (const file of messageAttachments(message)) {
      if (file.id) sources.set(file.id, { label: file.filename });
    }
  }
  return sources;
}

function AssistantParts({
  messageId,
  parts,
  onDecide,
  imagesUrl: imagesUrlOverride,
  editSources,
  onOpenArtifact,
  latestVersionOf,
}: {
  messageId: string;
  parts: UIMessage["parts"];
  onDecide?: (approved: boolean, allowForConversation?: boolean) => void;
  imagesUrl?: string;
  editSources?: ReadonlyMap<string, EditSource>;
  onOpenArtifact?: (ref: ArtifactRef) => void;
  latestVersionOf?: (artifactId: string) => number | undefined;
}) {
  const sources = sourcesOf(parts);
  const { generatedImagesUrl } = useChatAdapter();
  const { t } = useI18n();
  const imagesUrl = imagesUrlOverride ?? generatedImagesUrl;
  return (
    <ReplySources value={sources}>
      {replySegments(parts).map((segment) =>
        segment.type === "text" ? (
          <Markdown
            key={segment.key}
            className="prose prose-sm min-w-0 max-w-[80ch] dark:prose-invert max-md:[&_table]:block max-md:[&_table]:overflow-x-auto"
            components={replyComponents}
          >
            {segment.content}
          </Markdown>
        ) : segment.type === "image" ? (
          <GeneratedImageBlock
            key={segment.key}
            image={segment.image}
            imagesUrl={imagesUrl}
            editedFrom={segment.image.editedFrom?.map(
              (id) => editSources?.get(id) ?? { label: t("chat.imageEarlier") },
            )}
          />
        ) : segment.type === "searches" ? (
          <SearchRow key={segment.key} searches={segment.searches} sources={sources} />
        ) : (
          <Fragment key={segment.key}>
            {segment.call.name === createArtifactToolName ||
            segment.call.name === updateArtifactToolName ? (
              <ArtifactCard
                call={segment.call}
                messageId={messageId}
                latestVersion={artifactTarget(segment.call, latestVersionOf)}
                onOpen={onOpenArtifact}
              />
            ) : (
              <ToolCallRow call={segment.call} onDecide={onDecide} />
            )}
            <SourceChips sources={pageSourcesOf(segment.call, sources)} />
          </Fragment>
        ),
      )}
    </ReplySources>
  );
}

/**
 * A streaming reply shows the typing loader until text arrives: before its first token, and
 * after a finished search or tool call. A running search or tool call shows its own spinner instead.
 */
function waitingForText(parts: UIMessage["parts"]) {
  const shown = parts.filter((part) =>
    part.type === "text"
      ? part.content !== ""
      : webSearchOf(part) !== null || toolCallOf(part) !== null || generatedImageOf(part) !== null,
  );
  const last = shown.at(-1);
  if (!last) return true;
  if (last.type === "text") return false;
  const running =
    webSearchOf(last)?.state === "running" ||
    toolCallOf(last)?.status === "running" ||
    generatedImageOf(last)?.state === "running";
  return !running;
}

/** Why the reply ended in `error`, with a way to fix a rejected key. */
function ErrorMessage({ info }: { info: MessageInfo }) {
  const { Link } = useChatAdapter();
  const byok = useByok();
  const i18n = useI18n();
  const { text, keySettings } = describeError(i18n, info);
  return (
    <SystemMessage variant="error" fill role="alert" className="max-w-[80ch]">
      {text}
      {keySettings && byok && (
        <>
          {" "}
          <Link page={{ to: "keys" }} className="font-medium underline underline-offset-2">
            {i18n.t("chat.keySettings")}
          </Link>
        </>
      )}
    </SystemMessage>
  );
}
