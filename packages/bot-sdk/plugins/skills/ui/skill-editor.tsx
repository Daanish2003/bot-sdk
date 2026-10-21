import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { dateFormat } from "../../../core/client/intl";
import { useI18n, useOrpc } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";

/** Refetches the Bot's Skills after a change to its files. */
function useRefresh() {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.skills.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.skills.read.key() }),
    ]);
}

/** Saves a Skill and shows why it is not usable, if so; `onSaved` runs once it is written. */
function useSave(botId: string, onSaved?: () => void) {
  const i18n = useI18n();
  const orpc = useOrpc();
  const refresh = useRefresh();
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation(
    orpc.skills.save.mutationOptions({
      onSuccess: async (result) => {
        setProblem(result.problem);
        toast.success(i18n.t("bots.skillSavedToast"));
        await refresh();
        onSaved?.();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  return {
    problem,
    save: (name: string, content: string) => save.mutate({ botId, name, content }),
    saving: save.isPending,
  };
}

function Problem({ reason }: { reason: string | null }) {
  const { t } = useI18n();
  if (!reason) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {t("bots.skillNotUsableReason", { reason })}
    </p>
  );
}

/**
 * The raw `SKILL.md` of Skill `name` in a box, with its path, when it last changed, **Save** and
 * **Delete** (spec #713). A save is checked like any Skill and may be "not usable": the reason shows
 * under the box. The Skill popover and the Skill chip both expand to it. `onDeleted` runs after a
 * delete.
 */
export function SkillEditor({
  botId,
  name,
  onDeleted,
}: {
  botId: string;
  name: string;
  onDeleted?: () => void;
}) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const orpc = useOrpc();
  const refresh = useRefresh();
  const read = useQuery(orpc.skills.read.queryOptions({ input: { botId, name } }));
  const [edited, setEdited] = useState<string | null>(null);
  const { problem, save, saving } = useSave(botId, () => setEdited(null));
  const remove = useMutation(
    orpc.skills.remove.mutationOptions({
      onSuccess: async () => {
        toast.success(t("bots.skillDeleted"));
        await refresh();
        onDeleted?.();
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const content = edited ?? read.data?.content ?? "";
  const modified = read.data?.lastModified;

  return (
    <div className="flex flex-col gap-2">
      {read.isError && (
        <p role="alert" className="text-xs text-destructive">
          {serverErrorText(i18n, read.error)}
        </p>
      )}
      {read.data && (
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {read.data.path}
          {modified && (
            <span className="font-sans">
              {" · "}
              {t("bots.skillModified", {
                time: dateFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
                  modified,
                ),
              })}
            </span>
          )}
        </p>
      )}
      <textarea
        aria-label={t("bots.skillFile")}
        className="min-h-40 rounded border bg-transparent p-2 font-mono text-xs"
        value={content}
        disabled={read.isPending || read.isError}
        onChange={(event) => setEdited(event.target.value)}
      />
      <Problem reason={problem} />
      <div className="flex gap-2">
        <Button size="sm" disabled={edited === null || saving} onClick={() => save(name, content)}>
          {t("bots.skillSave")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={remove.isPending || read.isError}
          onClick={() => remove.mutate({ botId, name })}
        >
          {t("bots.skillDelete")}
        </Button>
      </div>
    </div>
  );
}

/**
 * **New Skill**: a name and the raw text, starting from a template whose description begins "Use
 * this when". The template follows the name until the text is edited. `onSaved` runs once the
 * Skill is written, even if it came back "not usable".
 */
export function NewSkillEditor({ botId, onSaved }: { botId: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [edited, setEdited] = useState<string | null>(null);
  const { problem, save, saving } = useSave(botId, onSaved);
  const content = edited ?? t("bots.skillTemplate", { name: name || "new-skill" });

  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label={t("bots.skillName")}
        placeholder={t("bots.skillName")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <textarea
        aria-label={t("bots.skillFile")}
        className="min-h-40 rounded border bg-transparent p-2 font-mono text-xs"
        value={content}
        onChange={(event) => setEdited(event.target.value)}
      />
      <Problem reason={problem} />
      <div>
        <Button size="sm" disabled={name === "" || saving} onClick={() => save(name, content)}>
          {t("bots.skillSave")}
        </Button>
      </div>
    </div>
  );
}
