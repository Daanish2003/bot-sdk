import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n, useOrpc } from "../../../../core/client/react/provider";
import { serverErrorText } from "../../../../core/client/rpc-error";

/** The Projects section of the Conversation panel: each Project's page, and a form for a new one. */
export function ProjectsSection() {
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const { Link, navigate } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const projects = useQuery(orpc.project.list.queryOptions());
  const create = useMutation(orpc.project.create.mutationOptions());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const { id } = await create.mutateAsync({ name: trimmed });
      setName("");
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: orpc.project.list.key() });
      await navigate({ to: "project", id });
    } catch (error) {
      toast.error(serverErrorText(i18n, error, "shell.couldntCreateProject"));
    }
  };

  return (
    <section aria-label={t("shell.projects")} className="border-b pb-1">
      <div className="flex h-8 items-center justify-between px-3">
        <h3 className="text-[10px] font-medium text-muted-foreground">{t("shell.projects")}</h3>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t("shell.newProject")}
          aria-label={t("shell.newProject")}
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          <PlusIcon />
        </Button>
      </div>
      {creating && (
        <form onSubmit={(event) => void submit(event)} className="flex gap-1.5 px-3 pb-2">
          <Input
            autoFocus
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("shell.projectName")}
            aria-label={t("shell.projectName")}
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            {t("shell.create")}
          </Button>
        </form>
      )}
      <ul>
        {projects.data?.items.map((project) => (
          <li key={project.id}>
            <Link
              page={{ to: "project", id: project.id }}
              className="block truncate px-3 py-1.5 text-xs hover:bg-sidebar-accent"
              activeClassName="bg-sidebar-accent text-primary"
            >
              {project.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
