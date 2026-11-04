import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useChatAdapter, useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useCreateRepresentative,
  useRefreshRepresentatives,
  useRepresentatives,
} from "@botsdk/representative/react";

import { LimitWarning } from "./limit-warning";

/** The form that creates a Representative, reporting to one of the owner's Bots or to the owner. */
function NewRepresentativeForm() {
  const i18n = useI18n();
  const { t } = i18n;
  const { orpc, navigate } = useChatAdapter();
  const bots = useQuery(orpc.bots.list.queryOptions());
  const refresh = useRefreshRepresentatives();
  const [name, setName] = useState("");
  const [botId, setBotId] = useState("");
  const create = useCreateRepresentative({
    onSuccess: async (created) => {
      await refresh();
      await navigate({ to: "representatives", id: created.id });
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ name, ...(botId && { botId }) });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="representative-name">{t("representative.name")}</Label>
        <Input
          id="representative-name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="representative-bot">{t("representative.reportsTo")}</Label>
        <select
          id="representative-bot"
          value={botId}
          onChange={(event) => setBotId(event.target.value)}
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="">{t("representative.reportsToYou")}</option>
          {bots.data?.map((bot) => (
            <option key={bot.id} value={bot.id}>
              {bot.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={create.isPending || name.trim() === ""}>
        {t("representative.create")}
      </Button>
    </form>
  );
}

/**
 * Representatives: the owner's list with a form for a new one. The Host mounts it at
 * `/representatives` and routes `{ to: "representatives", id }` to `RepresentativePage`.
 */
export function RepresentativesPage() {
  const { t } = useI18n();
  const { Link, orpc } = useChatAdapter();
  const representatives = useRepresentatives();
  const bots = useQuery(orpc.bots.list.queryOptions());
  const botName = (id: string | null) =>
    id === null
      ? t("representative.reportsToYou")
      : (bots.data?.find((bot) => bot.id === id)?.name ?? "");

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t("representative.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("representative.intro")}</p>
      </div>
      <LimitWarning />
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.new")}</h2>
        <NewRepresentativeForm />
      </section>
      {representatives.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("representative.none")}</p>
      )}
      <ul className="divide-y overflow-hidden rounded-xl border empty:hidden">
        {representatives.data?.map((item) => (
          <li key={item.id}>
            <Link
              page={{ to: "representatives", id: item.id }}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted"
            >
              <span className="flex-1 space-y-0.5">
                <span className="block text-sm font-medium">{item.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("representative.reportsTo")}: {botName(item.botId)} ·{" "}
                  {item.liveReleaseNumber === null
                    ? t("representative.noRelease")
                    : t("representative.live", { number: item.liveReleaseNumber })}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {item.enabled ? t("representative.on") : t("representative.off")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
