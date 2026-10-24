import { type CuratedModel, findModel, type ListedModel } from "../../shared/models";
import { providerLabel } from "../../shared/credentials/services";
import { buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  ChevronDownIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";

import { modelGroups } from "../../client/models";

import { useByok } from "../../client/react/byok";
import { useChatAdapter, useI18n } from "../../../../core/client/react/provider";
import { useQuota } from "../../client/react/quota";
import { quotaBlocksModel, quotaResetsAt } from "../../client/quota";

/**
 * The top-bar Model picker: a popover with a search box, the available Models grouped by
 * Provider with capability icons, a check on the selected one, and "Add a Provider…" (only when
 * `byok` is on).
 */
export function ModelPicker({
  value,
  models,
  onSelect,
  invalid = false,
}: {
  /** The selected Model, `"provider:model"`. */
  value: string | undefined;
  /** The Models the user can pick (`models.list`). */
  models: ListedModel[];
  onSelect: (model: string) => void;
  /** The selected Model can't be sent to (its Provider has no credentials). */
  invalid?: boolean;
}) {
  const { Link } = useChatAdapter();
  const { t, locale } = useI18n();
  const byok = useByok();
  const quota = useQuota().data;
  // A spent Quota turns the Host's Models off until it resets (ADR 0007).
  const offTitle = quota
    ? t("shell.hostModelsOff", { resetsAt: quotaResetsAt(quota.resetsAt, locale) })
    : undefined;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = value
    ? (models.find((model) => model.id === value) ?? findModel(value))
    : undefined;
  const groups = modelGroups(models, search);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger
        aria-label={t("shell.model")}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "min-w-0",
          invalid && "text-destructive",
        )}
      >
        {selected ? (
          <>
            <span className="text-muted-foreground max-sm:hidden">
              {providerLabel(selected.provider)}
            </span>
            <span className="truncate">{selected.label}</span>
          </>
        ) : (
          (value ?? t("shell.pickAModel"))
        )}
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent className="flex w-80 flex-col">
        <div className="flex items-center gap-2 border-b px-2.5">
          <SearchIcon className="size-3.5 text-muted-foreground" />
          <input
            aria-label={t("shell.searchModels")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("shell.searchModelsPlaceholder")}
            className="h-9 flex-1 bg-transparent text-xs outline-none"
          />
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {groups.map((group) => (
            <div key={group.provider} role="group" aria-label={group.label} className="p-1">
              <div className="px-1.5 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
                {group.live && <span className="ml-1.5 normal-case">{t("shell.liveList")}</span>}
              </div>
              {group.models.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  disabled={quotaBlocksModel(model, quota)}
                  title={quotaBlocksModel(model, quota) ? offTitle : undefined}
                  aria-pressed={model.id === value}
                  onClick={() => {
                    setOpen(false);
                    setSearch("");
                    if (model.id !== value) onSelect(model.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted",
                    model.id === value && "bg-muted",
                  )}
                >
                  <span className="flex-1 truncate">{model.label}</span>
                  {model.onHostCredentials && (
                    <span
                      className="rounded border px-1 text-[10px] text-muted-foreground"
                      title={t("shell.hostCredentials")}
                    >
                      {t("shell.hostBadge")}
                    </span>
                  )}
                  <Capabilities model={model} />
                  <CheckIcon
                    aria-hidden
                    className={cn("size-3 text-primary", model.id !== value && "invisible")}
                  />
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2.5 py-4 text-center text-xs text-muted-foreground">
              {models.length === 0
                ? byok
                  ? t("shell.noProviderCredentials")
                  : t("shell.noModels")
                : t("shell.noMatchingModels")}
            </p>
          )}
        </div>
        {byok && (
          <Link
            page={{ to: "keys" }}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 border-t px-2.5 py-2 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted"
          >
            <PlusIcon className="size-3.5" /> {t("shell.addProvider")}
          </Link>
        )}
      </PopoverContent>
    </Popover>
  );
}

const capabilities = [
  { key: "images", label: "shell.readsImages", Icon: ImageIcon },
  { key: "pdfs", label: "shell.readsPdfs", Icon: FileTextIcon },
  { key: "tools", label: "shell.usesTools", Icon: GlobeIcon },
  { key: "computerUse", label: "shell.usesComputer", Icon: MonitorIcon },
] as const;

function Capabilities({ model }: { model: CuratedModel }) {
  const { t } = useI18n();
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {capabilities.map(({ key, label, Icon }) =>
        model[key] ? (
          <Icon key={key} role="img" aria-label={t(label)} className="size-3">
            <title>{t(label)}</title>
          </Icon>
        ) : (
          <span key={key} className="size-3" />
        ),
      )}
    </span>
  );
}
