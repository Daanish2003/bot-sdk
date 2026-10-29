import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  type NotificationRoute,
  type NotificationSettings,
  notificationRoutes,
  quietHoursSchema,
} from "@botsdk/client/bot/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { serverErrorText } from "@botsdk/react/rpc-error";
import { useI18n, useOrpc } from "@botsdk/react/provider";

/** Quiet hours as the form first offers them when turned on. */
const suggestedQuietHours = { start: "22:00", end: "07:00" };

/** A routing choice: one of the routes, or `null` for the default. */
type Choice = NotificationRoute | null;

const choiceKeys = {
  default: "settings.routeDefault",
  in_app: "settings.routeInApp",
  email: "settings.routeEmail",
} as const;

/** The routing choices as pills: one is chosen. */
function ChoicePills({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Choice;
  onChange: (choice: Choice) => void;
}) {
  const { t } = useI18n();
  const choices: Choice[] = [null, ...notificationRoutes];
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {choices.map((choice) => (
        <button
          key={choice ?? "default"}
          type="button"
          role="radio"
          aria-checked={choice === value}
          onClick={() => onChange(choice)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            choice === value
              ? "border-primary bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {t(choiceKeys[choice ?? "default"])}
        </button>
      ))}
    </div>
  );
}

/**
 * The Notifications section (spec #1024): Quiet hours, and where urgent Messages and the rest go
 * when a Bot writes first, for all the user's Bots. A plain form, saved with one button.
 */
export function NotificationsSection() {
  const orpc = useOrpc();
  const { t } = useI18n();
  const settings = useQuery(orpc.notifications.get.queryOptions());

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("settings.notifications")}</h2>
      <p className="text-xs text-muted-foreground">{t("settings.notificationsHelp")}</p>
      {settings.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("settings.notificationsLoadFailed")}
        </p>
      )}
      {/* Settings that change elsewhere (another tab) start the form over from them. */}
      {settings.data && (
        <NotificationsForm key={JSON.stringify(settings.data)} saved={settings.data} />
      )}
    </section>
  );
}

function NotificationsForm({ saved }: { saved: NotificationSettings }) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const queryClient = useQueryClient();
  const [quietOn, setQuietOn] = useState(saved.quietHours !== null);
  const [quietHours, setQuietHours] = useState(saved.quietHours ?? suggestedQuietHours);
  const [urgent, setUrgent] = useState<Choice>(saved.urgent);
  const [other, setOther] = useState<Choice>(saved.other);
  const save = useMutation(
    orpc.notifications.update.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(orpc.notifications.get.queryKey(), next);
        toast.success(t("settings.notificationsSaved"));
      },
      onError: (error) => toast.error(serverErrorText(i18n, error)),
    }),
  );
  const validQuietHours = !quietOn || quietHoursSchema.safeParse(quietHours).success;

  return (
    <form
      className="space-y-4 rounded-xl border px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ quietHours: quietOn ? quietHours : null, urgent, other });
      }}
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox id="quiet-hours" checked={quietOn} onCheckedChange={setQuietOn} />
          <Label htmlFor="quiet-hours">{t("settings.quietHours")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.quietHoursHelp")}</p>
        {quietOn && (
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label htmlFor="quiet-hours-start">{t("settings.quietFrom")}</Label>
              <Input
                id="quiet-hours-start"
                type="time"
                value={quietHours.start}
                onChange={(event) => setQuietHours({ ...quietHours, start: event.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quiet-hours-end">{t("settings.quietTo")}</Label>
              <Input
                id="quiet-hours-end"
                type="time"
                value={quietHours.end}
                onChange={(event) => setQuietHours({ ...quietHours, end: event.target.value })}
              />
            </div>
          </div>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm">{t("settings.urgentRoute")}</p>
        <ChoicePills label={t("settings.urgentRoute")} value={urgent} onChange={setUrgent} />
      </div>
      <div className="space-y-1">
        <p className="text-sm">{t("settings.otherRoute")}</p>
        <ChoicePills label={t("settings.otherRoute")} value={other} onChange={setOther} />
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.routeHelp")}</p>
      <Button type="submit" size="sm" disabled={save.isPending || !validQuietHours}>
        {t("settings.saveNotifications")}
      </Button>
    </form>
  );
}
