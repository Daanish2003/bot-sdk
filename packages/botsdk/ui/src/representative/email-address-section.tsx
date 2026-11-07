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
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useEmailAddress,
  useRotateEmailAddress,
  useStoreEmailAddress,
} from "@botsdk/representative/react";

/**
 * A Representative's email address (ticket #1346): the owner sees, copies and rotates it. Rotating
 * asks first, as the old address stops at once. Nothing shows when the Host has no email Channel.
 */
export function EmailAddressSection({ id }: { id: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const address = useEmailAddress(id);
  const store = useStoreEmailAddress(id);
  const [confirming, setConfirming] = useState(false);
  const refused = (error: unknown) => toast.error(serverErrorText(i18n, error));
  const rotate = useRotateEmailAddress({
    onSuccess: (view) => {
      store(view);
      toast.success(t("representative.emailAddressRotated"));
    },
    onError: refused,
  });

  if (address.data === undefined && address.isError) {
    return <p className="text-sm text-destructive">{t("representative.emailAddressLoadFailed")}</p>;
  }
  if (!address.data) return null;
  const { address: value } = address.data;
  return (
    <section data-representative-email-address="" className="space-y-2">
      <h2 className="text-sm font-medium">{t("representative.emailAddress")}</h2>
      <p className="text-xs text-muted-foreground">{t("representative.emailAddressHelp")}</p>
      <Input
        aria-label={t("representative.emailAddress")}
        value={value}
        readOnly
        className="font-mono"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            void navigator.clipboard
              .writeText(value)
              .then(() => toast.success(t("representative.emailAddressCopied")))
              .catch(refused)
          }
        >
          {t("representative.emailAddressCopy")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rotate.isPending}
          onClick={() => setConfirming(true)}
        >
          {t("representative.emailAddressRotate")}
        </Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("representative.emailAddressRotate")}</DialogTitle>
            <DialogDescription>{t("representative.emailAddressRotateConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              {t("representative.widgetKeyCancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                rotate.mutate({ id });
              }}
            >
              {t("representative.emailAddressRotate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
