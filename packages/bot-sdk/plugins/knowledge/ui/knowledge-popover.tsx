import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LibraryIcon } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";

const kib = 1024;
const mib = kib * kib;

/** Whether the server converts this file (a PDF or DOCX) rather than storing its text as it is. */
const isDocument = (name: string) => /\.(pdf|docx)$/i.test(name);

/** A size as "512 B", "2 KB" or "31 MB": one decimal at most, none when it is whole. */
function sizeText(bytes: number): string {
  const whole = (value: number) => String(Math.round(value * 10) / 10);
  if (bytes >= mib) return `${whole(bytes / mib)} MB`;
  if (bytes >= kib) return `${whole(bytes / kib)} KB`;
  return `${bytes} B`;
}

/** A file on its way up: read, then sent (a PDF or DOCX is converted first; either wakes the Computer), or refused with its reason. */
type InFlight =
  | { id: number; name: string; state: "reading" | "sending" | "converting" }
  | { id: number; name: string; state: "refused"; reason: string };

/** A file that is waiting for a "Replace?" answer. */
type Replacing = { file: File; folder: string; path: string };

/**
 * The Bot header's **Knowledge N** button (spec #737, prototype variant A): a popover over the
 * user's Knowledge, shared by all of their Bots, with a usage meter, a drop zone, **Upload** into
 * the selected folder, **New folder**, and the folder tree. Each file shows its size and who saved
 * it, and **Delete**. An upload shows *Uploading…* and *Waking your Computer…*; a refusal shows its
 * reason and "Nothing was added"; a PDF or DOCX shows *Converting…* instead, and its row expands to the
 * readable text the Bots read. A name already in the folder asks "Replace?". The list is read
 * when the popover opens, which wakes the Computer. Render it only when the Host installs the
 * `knowledge` plugin; without the `computer` plugin it renders nothing.
 */
export function KnowledgePopover() {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [inFlight, setInFlight] = useState<InFlight[]>([]);
  const [replaceQueue, setReplaceQueue] = useState<Replacing[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const nextId = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const status = useQuery(orpc.knowledgeFiles.status.queryOptions());
  const list = useQuery({ ...orpc.knowledgeFiles.list.queryOptions(), enabled: open });
  const upload = useMutation(orpc.knowledgeFiles.upload.mutationOptions());
  const uploadDocument = useMutation(orpc.knowledgeFiles.uploadDocument.mutationOptions());
  const remove = useMutation(orpc.knowledgeFiles.remove.mutationOptions());
  const createFolder = useMutation(orpc.knowledgeFiles.createFolder.mutationOptions());

  // Shown once the server says the user can have Knowledge, so it never flickers in and out.
  if (!status.data?.available) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.knowledgeFiles.key() });
  const update = (id: number, next: InFlight | null) =>
    setInFlight((rows) =>
      next ? rows.map((row) => (row.id === id ? next : row)) : rows.filter((row) => row.id !== id),
    );

  async function send(file: File, folder: string, replace: boolean) {
    const id = nextId.current++;
    setInFlight((rows) => [...rows, { id, name: file.name, state: "reading" }]);
    try {
      if (isDocument(file.name)) {
        update(id, { id, name: file.name, state: "converting" });
        await uploadDocument.mutateAsync({ folder, file, ...(replace && { replace }) });
      } else {
        const content = await file.text();
        update(id, { id, name: file.name, state: "sending" });
        await upload.mutateAsync({ folder, name: file.name, content, ...(replace && { replace }) });
      }
      update(id, null);
      await refresh();
    } catch (error) {
      update(id, {
        id,
        name: file.name,
        state: "refused",
        reason: serverErrorText(i18n, error),
      });
    }
  }

  /** Sends the files one after another, so they don't race on the Computer; a name already there waits for its Replace? answer. */
  async function add(files: FileList | File[]) {
    if (!list.data) return;
    const known = new Set(list.data.files.map((file) => file.path));
    const asking: Replacing[] = [];
    for (const file of files) {
      const path = selected === "" ? file.name : `${selected}/${file.name}`;
      if (known.has(path)) asking.push({ file, folder: selected, path });
      else await send(file, selected, false);
    }
    setReplaceQueue((queue) => [...queue, ...asking]);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    void add(event.dataTransfer.files);
  }

  const data = list.data;
  const replacing = replaceQueue[0];
  const folderLabel = selected === "" ? t("bots.knowledgeAllFiles") : selected;
  const entries = [
    ...(data?.folders.map((path) => ({ kind: "folder" as const, path })) ?? []),
    ...(data?.files.map((file) => ({ kind: "file" as const, ...file })) ?? []),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <LibraryIcon />{" "}
        {data ? t("bots.knowledgeCount", { count: data.files.length }) : t("bots.knowledge")}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[70vh] w-[28rem] flex-col gap-2 overflow-auto"
      >
        <p className="text-xs text-muted-foreground">{t("bots.knowledgeHint")}</p>
        {data && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <div
              role="meter"
              aria-label={t("bots.knowledge")}
              aria-valuemin={0}
              aria-valuenow={data.usage}
              aria-valuemax={data.limit}
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={`h-full ${data.usage > data.limit * 0.8 ? "bg-amber-500" : "bg-primary"}`}
                style={{ width: `${Math.min(100, (data.usage / data.limit) * 100)}%` }}
              />
            </div>
            <span className="whitespace-nowrap">
              {t("bots.knowledgeUsage", {
                used: sizeText(data.usage),
                limit: sizeText(data.limit),
              })}
            </span>
          </div>
        )}
        {list.isError && (
          <p role="alert" className="text-xs text-destructive">
            {serverErrorText(i18n, list.error)}
          </p>
        )}
        <div
          className="rounded-lg border-2 border-dashed p-2 text-center text-xs text-muted-foreground"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          {t("bots.knowledgeDrop")}
          <div className="text-[10px]">{t("bots.knowledgeFormats")}</div>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept=".md,.txt,.html,.csv,.docx,.pdf"
          onChange={(event) => {
            void add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!data}
            onClick={() => input.current?.click()}
          >
            {t("bots.knowledgeUploadInto", { folder: folderLabel })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setNaming(naming === null ? "" : null)}
          >
            {t("bots.knowledgeNewFolder")}
          </Button>
        </div>
        {naming !== null && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const path = selected === "" ? naming.trim() : `${selected}/${naming.trim()}`;
              createFolder.mutate(
                { path },
                {
                  onSuccess: () => {
                    setNaming(null);
                    void refresh();
                  },
                  onError: (error) => toast.error(serverErrorText(i18n, error)),
                },
              );
            }}
          >
            <Input
              aria-label={t("bots.knowledgeFolderName")}
              placeholder={t("bots.knowledgeFolderName")}
              value={naming}
              onChange={(event) => setNaming(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              disabled={naming.trim() === "" || createFolder.isPending}
            >
              {t("bots.knowledgeCreate")}
            </Button>
          </form>
        )}
        {replacing && (
          <div role="alertdialog" className="rounded-md border p-2 text-sm">
            <div className="font-medium">
              {t("bots.knowledgeReplaceQuestion", { path: replacing.path })}
            </div>
            <p className="mb-2 text-xs text-muted-foreground">{t("bots.knowledgeReplaceText")}</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReplaceQueue((queue) => queue.slice(1))}
              >
                {t("bots.knowledgeCancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  void send(replacing.file, replacing.folder, true);
                  setReplaceQueue((queue) => queue.slice(1));
                }}
              >
                {t("bots.knowledgeReplace")}
              </Button>
            </div>
          </div>
        )}
        {inFlight.length > 0 && (
          <ul className="flex flex-col gap-1">
            {inFlight.map((row) => (
              <li key={row.id} className="rounded-md border p-2 text-sm">
                <span className="font-medium">{row.name}</span>
                {row.state === "refused" ? (
                  <div role="alert" className="flex gap-2 text-xs text-destructive">
                    <span>{t("bots.knowledgeRefused", { reason: row.reason })}</span>
                    <button
                      type="button"
                      className="ml-auto underline"
                      onClick={() => update(row.id, null)}
                    >
                      {t("bots.knowledgeDismiss")}
                    </button>
                  </div>
                ) : (
                  <div role="status" className="text-xs text-muted-foreground">
                    {row.state === "reading"
                      ? t("bots.knowledgeUploading")
                      : row.state === "converting"
                        ? t("bots.knowledgeConverting")
                        : t("bots.knowledgeWaking")}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {data?.files.length === 0 && data.folders.length === 0 && inFlight.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("bots.knowledgeNone")}
          </p>
        )}
        {data && (
          <ul className="flex flex-col">
            <li>
              <button
                type="button"
                aria-pressed={selected === ""}
                className="w-full px-2 py-1 text-left text-sm aria-pressed:font-medium"
                onClick={() => setSelected("")}
              >
                {t("bots.knowledgeAllFiles")}
              </button>
            </li>
            {entries.map((entry) => {
              const depth = entry.path.split("/").length - 1;
              const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
              return entry.kind === "folder" ? (
                <li key={`d:${entry.path}`} style={{ paddingLeft: `${depth}rem` }}>
                  <button
                    type="button"
                    aria-pressed={selected === entry.path}
                    className="w-full px-2 py-1 text-left text-sm aria-pressed:font-medium"
                    onClick={() => setSelected(entry.path)}
                  >
                    📁 {name}
                  </button>
                </li>
              ) : (
                <li
                  key={`f:${entry.path}`}
                  className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
                  style={{ paddingLeft: `${depth + 0.5}rem` }}
                >
                  <span className="truncate">{name}</span>
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    {entry.savedBy === "user"
                      ? t("bots.knowledgeSavedByYou")
                      : (entry.botName ?? t("bots.knowledgeSavedByBot"))}
                  </span>
                  <span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
                    {sizeText(entry.size)}
                  </span>
                  {entry.readable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={previewing === entry.path}
                      onClick={() => setPreviewing(previewing === entry.path ? null : entry.path)}
                    >
                      {previewing === entry.path
                        ? t("bots.knowledgeHideReadable")
                        : t("bots.knowledgeShowReadable")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(
                        { path: entry.path },
                        {
                          onSuccess: () => {
                            toast.success(t("bots.knowledgeDeleted"));
                            void refresh();
                          },
                          onError: (error) => toast.error(serverErrorText(i18n, error)),
                        },
                      )
                    }
                  >
                    {t("bots.knowledgeDelete")}
                  </Button>
                  {entry.readable && previewing === entry.path && (
                    <ReadableText path={entry.readable} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A converted file's readable copy: what the Bots read, with its page markers. */
function ReadableText({ path }: { path: string }) {
  const i18n = useI18n();
  const orpc = useOrpc();
  const readable = useQuery(orpc.knowledgeFiles.read.queryOptions({ input: { path } }));
  return (
    <div className="basis-full">
      <div className="text-[11px] font-medium text-muted-foreground">
        {i18n.t("bots.knowledgeReadableText")}
      </div>
      {readable.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {serverErrorText(i18n, readable.error)}
        </p>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
          {readable.data?.content}
        </pre>
      )}
    </div>
  );
}
