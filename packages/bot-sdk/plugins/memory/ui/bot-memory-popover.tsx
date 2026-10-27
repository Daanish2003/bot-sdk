import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import type { MemoryContract } from "../shared/contract";

type Tier = "profile" | "log" | "notes";

/** The file a line is in, as the router names it. */
type FileRef = { botId: string; tier: Tier; month?: string };

/** One line of the popover, whatever its tier. */
type Row = {
  key: string;
  file: FileRef;
  line: number;
  /** The line as the file has it, which an edit changes. */
  text: string;
  /** What the row shows: the line without its date and importance. */
  body: string;
  date?: string;
  importance?: number;
  /** The name of the Bot that owns another Bot's Profile line. */
  botName?: string | null;
  inPrompt: boolean;
};

/**
 * The Bot header's **Memory** button (#630, prototype variant A): a popover with the Bot's Profile
 * (shared, the other Bots' lines labelled), Log and Notes. A line has a dot for in the prompt or
 * search only, edits in place (Enter saves, Esc cancels) and deletes on hover. Each section has an
 * "Add to …" box and **View as file**, the raw text with **Save**; a filter box narrows the lines.
 * With Memory off it says so. Render it only when the Host installs the `memory` plugin; without
 * the `computer` plugin it renders nothing, as Bot memory is skipped then.
 */
export function BotMemoryPopover({ botId }: { botId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ memory: MemoryContract }>();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const status = useQuery(orpc.memory.status.queryOptions());
  const list = useQuery({
    ...orpc.memory.botList.queryOptions({ input: { botId } }),
    enabled: open,
  });
  const data = list.data;

  const rows = (tier: Tier): Row[] => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    const all: Row[] =
      tier === "profile"
        ? data.profile.map((entry) => ({
            key: `${entry.botId}:${entry.line}:${entry.text}`,
            file: { botId: entry.botId, tier },
            line: entry.line,
            text: entry.text,
            body: entry.text,
            botName: entry.botName,
            inPrompt: entry.inPrompt,
          }))
        : tier === "log"
          ? data.log.map((entry) => ({
              key: `${entry.month}:${entry.line}:${entry.text}`,
              file: { botId, tier, month: entry.month },
              line: entry.line,
              text: entry.text,
              body: entry.body,
              date: entry.date,
              importance: entry.importance,
              inPrompt: entry.inPrompt,
            }))
          : data.notes.map((entry) => ({
              key: `${entry.line}:${entry.text}`,
              file: { botId, tier },
              line: entry.line,
              text: entry.text,
              body: entry.body,
              date: entry.date,
              inPrompt: entry.inPrompt,
            }));
    return needle ? all.filter((row) => row.text.toLowerCase().includes(needle)) : all;
  };

  // Shown once the server says Bots can have memory, so it never flickers in and out.
  if (!status.data?.botMemoryAvailable) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <BrainIcon /> {t("bots.memory")}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[70vh] w-96 flex-col gap-4 overflow-auto">
        {list.isError && (
          <p role="alert" className="text-xs text-destructive">
            {serverErrorText(i18n, list.error)}
          </p>
        )}
        {data && !data.enabled && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("bots.memoryOff")}
          </p>
        )}
        {data?.enabled && (
          <>
            <Input
              aria-label={t("bots.memoryFilter")}
              placeholder={t("bots.memoryFilter")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {(["profile", "log", "notes"] as const).map((tier) => (
              <Section
                key={tier}
                botId={botId}
                tier={tier}
                rows={rows(tier)}
                months={tier === "log" ? [...new Set(data.log.map((entry) => entry.month))] : []}
              />
            ))}
            <p className="text-[11px] text-muted-foreground">{t("bots.memoryLegend")}</p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Refetches the Bot's lists after a change to its files. */
function useRefresh() {
  const orpc = useOrpc<{ memory: MemoryContract }>();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.memory.botList.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.memory.botReadFile.key() }),
    ]);
}

const sectionKeys = {
  profile: "bots.memoryProfile",
  log: "bots.memoryLog",
  notes: "bots.memoryNotes",
} as const;

function Section({
  botId,
  tier,
  rows,
  months,
}: {
  botId: string;
  tier: Tier;
  rows: Row[];
  months: string[];
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ memory: MemoryContract }>();
  const refresh = useRefresh();
  const [draft, setDraft] = useState("");
  const [viewing, setViewing] = useState(false);
  const title = t(sectionKeys[tier]);
  const add = useMutation(
    orpc.memory.botAddLine.mutationOptions({
      onSuccess: async () => {
        setDraft("");
        await refresh();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const submit = () => {
    const text = draft.trim();
    if (text) add.mutate({ botId, tier, text });
  };

  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
          {tier === "profile" && (
            <span className="ml-1 normal-case">{t("bots.memoryProfileShared")}</span>
          )}
        </h3>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          aria-expanded={viewing}
          aria-label={`${t("bots.memoryViewFile")}: ${title}`}
          onClick={() => setViewing(!viewing)}
        >
          {t("bots.memoryViewFile")}
        </Button>
      </div>
      {viewing ? (
        <FileView
          file={{
            botId,
            tier,
            month: tier === "log" ? (months[0] ?? new Date().toISOString().slice(0, 7)) : undefined,
          }}
          months={months}
          title={title}
          onClose={() => setViewing(false)}
        />
      ) : (
        <>
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("bots.memoryNothing")}</p>
          )}
          <ul aria-label={title}>
            {rows.map((row) => (
              <LineRow key={row.key} row={row} />
            ))}
          </ul>
          <div className="flex items-center gap-1">
            <PlusIcon className="size-3.5 text-muted-foreground" />
            <input
              className="flex-1 bg-transparent text-sm outline-none"
              aria-label={t("bots.memoryAddTo", { section: title })}
              placeholder={t("bots.memoryAddTo", { section: title })}
              value={draft}
              disabled={add.isPending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </>
      )}
    </section>
  );
}

function LineRow({ row }: { row: Row }) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ memory: MemoryContract }>();
  const refresh = useRefresh();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.text);
  const onError = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const edit = useMutation(
    orpc.memory.botEditLine.mutationOptions({
      onSuccess: async () => {
        setEditing(false);
        await refresh();
      },
      onError,
    }),
  );
  const remove = useMutation(
    orpc.memory.botDeleteLine.mutationOptions({ onSuccess: refresh, onError }),
  );
  const cancel = () => {
    setDraft(row.text);
    setEditing(false);
  };
  const save = () => {
    const text = draft.trim();
    if (text === "" || text === row.text) cancel();
    else edit.mutate({ file: row.file, line: row.line, current: row.text, text });
  };

  return (
    <li className="group flex items-start gap-2 py-1 text-sm">
      <span
        role="img"
        aria-label={row.inPrompt ? t("bots.memoryInPrompt") : t("bots.memorySearchOnly")}
        title={row.inPrompt ? t("bots.memoryInPrompt") : t("bots.memorySearchOnly")}
        data-in-prompt={row.inPrompt}
        className={
          row.inPrompt
            ? "mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-500"
            : "mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/30"
        }
      />
      {editing ? (
        <Input
          autoFocus
          aria-label={t("bots.memoryEditLine")}
          value={draft}
          disabled={edit.isPending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.preventDefault();
              // Cancels the edit, not the popover.
              event.stopPropagation();
              cancel();
            }
          }}
        />
      ) : (
        <>
          <span className="min-w-0 flex-1 break-words">
            {row.date && (
              <span className="mr-1 font-mono text-[11px] text-muted-foreground">{row.date}</span>
            )}
            {row.body}
            {row.importance !== undefined && (
              <span className="ml-1 text-[11px] text-muted-foreground">
                {t("bots.memoryImportance", { importance: row.importance })}
              </span>
            )}
            {row.botName && (
              <span className="ml-1 text-[11px] text-muted-foreground">
                {t("bots.memoryFromBot", { name: row.botName })}
              </span>
            )}
          </span>
          <span className="flex shrink-0 gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("bots.memoryEditLine")}
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("bots.memoryDeleteLine")}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ file: row.file, line: row.line, current: row.text })}
            >
              <XIcon />
            </Button>
          </span>
        </>
      )}
    </li>
  );
}

/**
 * A file's raw text in a box, with **Save** to write it whole. The save is refused, with the
 * changed-underneath message, when the file changed since it was read.
 */
function FileView({
  file: initial,
  months,
  title,
  onClose,
}: {
  file: FileRef;
  months: string[];
  title: string;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ memory: MemoryContract }>();
  const refresh = useRefresh();
  const [month, setMonth] = useState(initial.month);
  const file: FileRef = { ...initial, month };
  const [edited, setEdited] = useState<string | null>(null);
  // The text the edit started from, which the save checks the file still reads.
  const [base, setBase] = useState("");
  const read = useQuery(orpc.memory.botReadFile.queryOptions({ input: { file } }));
  const save = useMutation(
    orpc.memory.botSaveFile.mutationOptions({
      onSuccess: async () => {
        toast.success(t("bots.memorySaved"));
        await refresh();
        onClose();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const content = edited ?? read.data?.content ?? "";

  return (
    <div className="flex flex-col gap-2">
      {months.length > 1 && (
        <select
          aria-label={t("bots.memoryFileMonth")}
          className="rounded border bg-transparent px-1 text-sm"
          value={month}
          onChange={(event) => {
            setMonth(event.target.value);
            setEdited(null);
          }}
        >
          {months.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      {read.isError && (
        <p role="alert" className="text-xs text-destructive">
          {serverErrorText(i18n, read.error)}
        </p>
      )}
      <textarea
        aria-label={t("bots.memoryFile", { section: title })}
        className="min-h-32 rounded border bg-transparent p-2 font-mono text-xs"
        value={content}
        disabled={read.isPending || read.isError}
        onChange={(event) => {
          if (edited === null) setBase(read.data?.content ?? "");
          setEdited(event.target.value);
        }}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={edited === null || save.isPending}
          onClick={() => save.mutate({ file, expected: base, content })}
        >
          {t("bots.memorySave")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("bots.memoryCloseFile")}
        </Button>
      </div>
    </div>
  );
}
