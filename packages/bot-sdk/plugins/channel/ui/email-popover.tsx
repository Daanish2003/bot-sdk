import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n, useOrpc } from "../../../core/client/react/provider";
import { serverErrorText } from "../../../core/client/rpc-error";

/**
 * The Bot header's **Email** button (spec #761, prototype variant A): a popover with the Bot's own
 * address, **Copy**, and **Rotate**, which asks to confirm first because the old address stops at
 * once, and the line "Next Bot-initiated Message goes by <Channel>" (variant C). The address is
 * read when the popover opens. Render it only when the Host installs the
 * `channel` plugin with the email adapter.
 */
export function EmailPopover({ botId }: { botId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const orpc = useOrpc();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const addressQuery = orpc.channel.email.address.queryOptions({ input: { botId } });
  const address = useQuery({ ...addressQuery, enabled: open });
  const rotate = useMutation(orpc.channel.email.rotate.mutationOptions());
  const refused = (error: unknown) => toast.error(serverErrorText(i18n, error));

  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(t("bots.emailCopied")))
      .catch(refused);
  const onRotate = () =>
    rotate.mutate(
      { botId },
      {
        onSuccess: (rotated) => {
          queryClient.setQueryData(
            addressQuery.queryKey,
            (shown) => shown && { ...shown, ...rotated },
          );
          setConfirming(false);
        },
        onError: refused,
      },
    );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConfirming(false);
      }}
    >
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <MailIcon /> {t("bots.email")}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-96 flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t("bots.emailHint")}</p>
        {address.data ? (
          <code className="rounded bg-muted px-2 py-1 text-xs break-all">
            {address.data.address}
          </code>
        ) : (
          <p className="text-xs text-muted-foreground">
            {address.error ? serverErrorText(i18n, address.error) : t("bots.emailLoading")}
          </p>
        )}
        {address.data && (
          <p className="text-xs text-muted-foreground" data-next-channel>
            {t("bots.emailNextChannel", {
              channel: t(address.data.nextChannel === "email" ? "bots.emailChannel" : "bots.web"),
            })}
          </p>
        )}
        {confirming ? (
          <div role="alert" className="flex flex-col gap-2 text-xs">
            <p>{t("bots.emailRotateConfirm")}</p>
            <div className="flex gap-2">
              <Button
                size="xs"
                variant="destructive"
                disabled={rotate.isPending}
                onClick={onRotate}
              >
                {t("bots.rotate")}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                {t("bots.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!address.data}
              onClick={() => address.data && void copy(address.data.address)}
            >
              {t("bots.emailCopy")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!address.data}
              onClick={() => setConfirming(true)}
            >
              {t("bots.rotate")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
