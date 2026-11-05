import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useCreateWidgetKey,
  useDisableWidgetKey,
  useRefreshRepresentatives,
  useRotateWidgetKey,
  useSetWidgetKeyOrigins,
  useWidgetKey,
} from "@botsdk/representative/react";

/** A button that asks first, for a change that ends every session of the key. */
function ConfirmedButton({
  label,
  question,
  pending,
  onConfirm,
}: {
  label: string;
  question: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>{question}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("representative.widgetKeyCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A Representative's public widget key: the owner creates it, lists its sites, rotates or disables it. */
export function WidgetKeySection({ id }: { id: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const widgetKey = useWidgetKey(id);
  const done = (saved?: string) => ({
    onSuccess: async () => {
      await refresh();
      if (saved) toast.success(saved);
    },
    onError: (error: Error) => toast.error(serverErrorText(i18n, error)),
  });
  const create = useCreateWidgetKey(done());
  const setOrigins = useSetWidgetKeyOrigins(done(t("representative.widgetKeyOriginsSaved")));
  const rotate = useRotateWidgetKey(done(t("representative.widgetKeyRotated")));
  const disable = useDisableWidgetKey(done(t("representative.widgetKeyDisabledToast")));

  if (widgetKey.data === undefined) return null;
  const key = widgetKey.data;
  return (
    <section data-representative-widget-key="" className="space-y-2">
      <h2 className="text-sm font-medium">{t("representative.widgetKey")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.widgetKeyHelp")}</p>
      {key === null ? (
        <Button
          variant="outline"
          size="sm"
          disabled={create.isPending}
          onClick={() => create.mutate({ id })}
        >
          {t("representative.widgetKeyCreate")}
        </Button>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="representative-widget-key">{t("representative.widgetKeyValue")}</Label>
            <Input id="representative-widget-key" value={key.key} readOnly className="font-mono" />
            <p className="text-xs text-muted-foreground">
              {key.status === "live"
                ? t("representative.widgetKeyLive")
                : t("representative.widgetKeyDisabled")}
            </p>
          </div>
          {/* Keyed by what's saved, so origins changed elsewhere reload the form. */}
          <form
            key={key.allowedOrigins.join("\n")}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              const origins = String(new FormData(event.currentTarget).get("origins"))
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean);
              setOrigins.mutate({ id, origins });
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="representative-widget-origins">
                {t("representative.widgetKeyOrigins")}
              </Label>
              <Textarea
                id="representative-widget-origins"
                name="origins"
                rows={3}
                defaultValue={key.allowedOrigins.join("\n")}
              />
              <p className="text-xs text-muted-foreground">
                {t("representative.widgetKeyOriginsHelp")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" size="sm" disabled={setOrigins.isPending}>
                {t("representative.widgetKeySaveOrigins")}
              </Button>
              <ConfirmedButton
                label={t("representative.widgetKeyRotate")}
                question={t("representative.widgetKeyRotateConfirm")}
                pending={rotate.isPending}
                onConfirm={() => rotate.mutate({ id })}
              />
              {key.status === "live" && (
                <ConfirmedButton
                  label={t("representative.widgetKeyDisable")}
                  question={t("representative.widgetKeyDisableConfirm")}
                  pending={disable.isPending}
                  onConfirm={() => disable.mutate({ id })}
                />
              )}
            </div>
          </form>
        </>
      )}
    </section>
  );
}
