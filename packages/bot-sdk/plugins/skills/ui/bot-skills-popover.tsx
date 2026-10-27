import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { BookOpenIcon } from "lucide-react";
import { useState } from "react";

import { useI18n, useOrpc } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import { NewSkillEditor, SkillEditor } from "./skill-editor";
import type { SkillsContract } from "../shared/contract";

/**
 * The Bot header's **Skills N** button (spec #713, prototype variant A): a popover with a row per
 * Skill (name, description, a "not usable" badge with its reason) that expands to the raw
 * `SKILL.md` editor, and **New Skill**. The list is read when the popover opens, which wakes the
 * Computer, so the count shows once it has. Render it only when the Host installs the `skills`
 * plugin; without the `computer` plugin it renders nothing.
 */
export function BotSkillsPopover({ botId }: { botId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc<{ skills: SkillsContract }>();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const status = useQuery(orpc.skills.status.queryOptions());
  const list = useQuery({
    ...orpc.skills.list.queryOptions({ input: { botId } }),
    enabled: open,
  });

  // Shown once the server says Bots can have Skills, so it never flickers in and out.
  if (!status.data?.available) return null;

  const skills = list.data;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <BookOpenIcon />{" "}
        {skills ? t("bots.skillsCount", { count: skills.length }) : t("bots.skills")}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[70vh] w-[28rem] flex-col gap-2 overflow-auto"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {t("bots.skillsHint")}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setCreating(!creating)}
          >
            {t("bots.skillsNew")}
          </Button>
        </div>
        {creating && (
          <div className="rounded-md border p-2">
            <NewSkillEditor botId={botId} onSaved={() => setCreating(false)} />
          </div>
        )}
        {list.isError && (
          <p role="alert" className="text-xs text-destructive">
            {serverErrorText(i18n, list.error)}
          </p>
        )}
        {skills?.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("bots.skillsNone")}
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {skills?.map((skill) => (
            <li key={skill.name} className="rounded-md border p-2">
              <button
                type="button"
                aria-expanded={expanded === skill.name}
                className="w-full text-left"
                onClick={() => setExpanded(expanded === skill.name ? null : skill.name)}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {skill.name}
                  {skill.problem && (
                    <span className="rounded bg-amber-100 px-1 text-[10px] text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                      {t("bots.skillNotUsable")}
                    </span>
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {skill.problem ?? skill.description ?? t("bots.skillNoDescription")}
                </span>
              </button>
              {expanded === skill.name && (
                <div className="mt-2">
                  <SkillEditor
                    botId={botId}
                    name={skill.name}
                    onDeleted={() => setExpanded(null)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
