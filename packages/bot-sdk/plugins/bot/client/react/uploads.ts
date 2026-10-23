import { useRef, useState } from "react";

import { useChatAdapter, useI18n } from "../../../../core/client/react/provider";
import { serverErrorText } from "../../../../core/client/rpc-error";
import { maxFileBytes, maxFilesPerMessage, type SentFile } from "../../shared/files";

/** A file in the composer: uploading, uploaded (with its `SentFile`), or refused with its error. */
export type DraftFile = {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "done" | "error";
  error?: string;
  file?: SentFile;
};

/**
 * The files attached to the Message being written (spec #801). Each uploads as soon as it is
 * picked; \`pending\` holds Send back until every one is done. A refused file (too large, too many,
 * rate-limited) stays as a chip with its error, for the user to remove.
 */
export function useBotUploads() {
  const { orpc } = useChatAdapter();
  const i18n = useI18n();
  const [items, setItems] = useState<DraftFile[]>([]);
  // Read at pick time, so files picked in one go count each other.
  const count = useRef(0);
  const update = (key: string, fields: Partial<DraftFile>) =>
    setItems((current) =>
      current.map((item) => (item.key === key ? { ...item, ...fields } : item)),
    );
  // From the latest items, not the render's: a refused send restores after later edits.
  const change = (next: (current: DraftFile[]) => DraftFile[]) =>
    setItems((current) => {
      const items = next(current);
      count.current = items.length;
      return items;
    });

  const add = (files: Iterable<File>) => {
    for (const file of files) {
      const key = crypto.randomUUID();
      const item: DraftFile = { key, name: file.name, size: file.size, state: "uploading" };
      const refused =
        count.current >= maxFilesPerMessage
          ? i18n.t("error.botFilesTooMany", { max: maxFilesPerMessage })
          : file.size > maxFileBytes
            ? i18n.t("error.botFileTooLarge", { name: file.name, max: maxFileBytes / 1024 / 1024 })
            : undefined;
      count.current += 1;
      if (refused) {
        setItems((current) => [...current, { ...item, state: "error", error: refused }]);
        continue;
      }
      setItems((current) => [...current, item]);
      orpc.bot.upload.call({ file }).then(
        (uploaded) => update(key, { state: "done", file: uploaded }),
        (error: unknown) => update(key, { state: "error", error: serverErrorText(i18n, error) }),
      );
    }
  };

  return {
    items,
    add,
    remove: (key: string) => change((current) => current.filter((item) => item.key !== key)),
    clear: () => change(() => []),
    /** Puts files back after a refused send: they are still uploaded. */
    restore: (files: SentFile[]) =>
      change((current) => [
        ...files.map((file) => ({
          key: file.id,
          name: file.name,
          size: file.size,
          state: "done" as const,
          file,
        })),
        ...current,
      ]),
    /** The uploaded files, in order, for \`send\`. */
    uploaded: items.flatMap((item) => (item.state === "done" && item.file ? [item.file] : [])),
    /** Sending waits: a file is still uploading, or was refused and should be removed. */
    pending: items.some((item) => item.state !== "done"),
  };
}

export type BotUploads = ReturnType<typeof useBotUploads>;
