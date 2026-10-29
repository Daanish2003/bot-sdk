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
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { serverErrorText } from "@botsdk/react/rpc-error";
import { useI18n, useOrpc } from "@botsdk/react/provider";

import { browserPushDevice, type PushDevice, PushDeniedError } from "./push-device";

/** Quiet hours as the form first offers them when turned on. */
const suggestedQuietHours = { start: "22:00", end: "07:00" };

/** A routing choice: one of the routes, or `null` for the default. */
type Choice = NotificationRoute | null;

const choiceKeys = {
  default: "settings.routeDefault",
  in_app: "settings.routeInApp",
  email: "settings.routeEmail",
  push: "settings.routePush",
} as const;

/** The routing choices as pills: one is chosen. */
function ChoicePills({
  label,
  value,
  onChange,
  pushOffered,
}: {
  label: string;
  value: Choice;
  onChange: (choice: Choice) => void;
  /** Whether the Host offers web push; a saved push choice still shows without it. */
  pushOffered: boolean;
}) {
  const { t } = useI18n();
  const choices: Choice[] = [
    null,
    ...notificationRoutes.filter((route) => route !== "push" || pushOffered || route === value),
  ];
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
 * when a Bot writes first, for all the user's Bots, as a plain form saved with one button. When the
 * Host offers web push, it is a third choice, and each device turns it on for itself. `pushDevice`
 * is this browser's push; tests pass a fake.
 */
export function NotificationsSection({
  pushDevice = browserPushDevice,
}: {
  pushDevice?: PushDevice;
}) {
  const orpc = useOrpc();
  const { t } = useI18n();
  const settings = useQuery(orpc.notifications.get.queryOptions());
  const pushKey = useQuery(orpc.notifications.push.key.queryOptions());

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
        <NotificationsForm
          key={JSON.stringify(settings.data)}
          saved={settings.data}
          pushOffered={Boolean(pushKey.data)}
        />
      )}
      {pushKey.data && <PushDeviceRow publicKey={pushKey.data} device={pushDevice} />}
    </section>
  );
}

/** Nothing to listen to: a browser's push support doesn't change while the page is open. */
const unchanging = () => () => {};

/**
 * This device's web push: why it can't be offered here, or a button to turn it on or off. Its
 * support is read in the browser only, so the server renders nothing.
 */
function PushDeviceRow({ publicKey, device }: { publicKey: string; device: PushDevice }) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const { t } = i18n;
  const queryClient = useQueryClient();
  const support = useSyncExternalStore(unchanging, device.support, () => null);
  const deviceKey = ["notifications", "push-device"];
  const current = useQuery({
    queryKey: deviceKey,
    queryFn: () => device.current(),
    enabled: support === "supported",
  });
  const failed = (error: unknown) =>
    toast.error(
      t(error instanceof PushDeniedError ? "settings.pushDenied" : "settings.pushFailed"),
    );
  const enable = useMutation({
    mutationFn: async () => {
      const subscription = await device.subscribe(publicKey);
      await orpc.notifications.push.subscribe.call(subscription);
      return subscription;
    },
    onSuccess: (subscription) => queryClient.setQueryData(deviceKey, subscription),
    onError: failed,
  });
  const disable = useMutation({
    mutationFn: async () => {
      const endpoint = await device.unsubscribe();
      if (endpoint) await orpc.notifications.push.unsubscribe.call({ endpoint });
    },
    onSuccess: () => queryClient.setQueryData(deviceKey, null),
    onError: failed,
  });
  if (support === null) return null;

  return (
    <div className="space-y-2 rounded-xl border px-4 py-3">
      <p className="text-sm">{t("settings.pushDevice")}</p>
      <p className="text-xs text-muted-foreground">{t("settings.pushDeviceHelp")}</p>
      {support === "unsupported" && (
        <p className="text-xs text-muted-foreground">{t("settings.pushUnsupported")}</p>
      )}
      {support === "needs-home-screen" && (
        <p className="text-xs text-muted-foreground">{t("settings.pushNeedsHomeScreen")}</p>
      )}
      {support === "supported" && current.isSuccess && current.data && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="text-xs">
            {t("settings.pushEnabled")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disable.isPending}
            onClick={() => disable.mutate()}
          >
            {t("settings.pushDisable")}
          </Button>
        </div>
      )}
      {support === "supported" && current.isSuccess && !current.data && (
        <Button type="button" size="sm" disabled={enable.isPending} onClick={() => enable.mutate()}>
          {t("settings.pushEnable")}
        </Button>
      )}
    </div>
  );
}

function NotificationsForm({
  saved,
  pushOffered,
}: {
  saved: NotificationSettings;
  pushOffered: boolean;
}) {
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
        <ChoicePills
          label={t("settings.urgentRoute")}
          value={urgent}
          onChange={setUrgent}
          pushOffered={pushOffered}
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm">{t("settings.otherRoute")}</p>
        <ChoicePills
          label={t("settings.otherRoute")}
          value={other}
          onChange={setOther}
          pushOffered={pushOffered}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("settings.routeHelp")}</p>
      <Button type="submit" size="sm" disabled={save.isPending || !validQuietHours}>
        {t("settings.saveNotifications")}
      </Button>
    </form>
  );
}
