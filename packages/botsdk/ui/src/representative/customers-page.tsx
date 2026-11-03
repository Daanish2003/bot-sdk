import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useAddCustomerIdentity,
  useCreateCustomer,
  useCustomers,
  useRefreshRepresentatives,
  useRenameCustomer,
  useSetCustomerBlocked,
  useUpdateCustomerIdentity,
} from "@botsdk/representative/react";
import type { CustomerView } from "@botsdk/representative/client";

type Identity = { channel: string; externalId: string };

/** The Channel and identity fields of one identity, saved with a button. */
function IdentityFields({
  label,
  initial,
  submitLabel,
  pending,
  onSubmit,
}: {
  label: string;
  initial: Identity;
  submitLabel: string;
  pending: boolean;
  onSubmit: (value: Identity) => void;
}) {
  const { t } = useI18n();
  const [channel, setChannel] = useState(initial.channel);
  const [externalId, setExternalId] = useState(initial.externalId);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ channel, externalId });
      }}
    >
      <Input
        className="w-32"
        aria-label={t("representative.customers.channelOf", { name: label })}
        value={channel}
        maxLength={64}
        onChange={(event) => setChannel(event.target.value)}
      />
      <Input
        className="w-56"
        aria-label={t("representative.customers.externalIdOf", { name: label })}
        value={externalId}
        maxLength={512}
        onChange={(event) => setExternalId(event.target.value)}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending || channel.trim() === "" || externalId.trim() === ""}
      >
        {submitLabel}
      </Button>
    </form>
  );
}

function CustomerCard({ customer }: { customer: CustomerView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const options = {
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.customers.saved"));
    },
    onError: (error: unknown) => toast.error(serverErrorText(i18n, error)),
  };
  const rename = useRenameCustomer(options);
  const update = useUpdateCustomerIdentity(options);
  const add = useAddCustomerIdentity(options);
  const block = useSetCustomerBlocked({ ...options, onSuccess: refresh });
  const [name, setName] = useState(customer.name ?? "");
  const label = customer.name ?? t("representative.customers.unnamed");
  const blockText = t(
    customer.blocked ? "representative.customers.unblock" : "representative.customers.block",
  );
  return (
    <li data-customer={customer.id} data-blocked={customer.blocked} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-56"
          aria-label={t("representative.customers.nameOf", { name: label })}
          placeholder={t("representative.customers.unnamed")}
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={rename.isPending || name.trim() === (customer.name ?? "")}
          onClick={() => rename.mutate({ id: customer.id, name })}
        >
          {t("representative.customers.saveName")}
        </Button>
        {customer.blocked && (
          <span className="text-xs font-medium">{t("representative.customers.blockedBadge")}</span>
        )}
        <Button
          className="ml-auto"
          variant={customer.blocked ? "outline" : "destructive"}
          size="sm"
          disabled={block.isPending}
          aria-label={`${blockText} ${label}`}
          onClick={() => block.mutate({ id: customer.id, blocked: !customer.blocked })}
        >
          {blockText}
        </Button>
      </div>
      {customer.blocked && (
        <p className="text-xs text-muted-foreground">{t("representative.customers.blockedHelp")}</p>
      )}
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t("representative.customers.identities")}
        </h3>
        {customer.identities.map((identity) => (
          <div key={identity.id} data-verified={identity.verified} className="space-y-1">
            <IdentityFields
              // Keyed by what is stored, so a refetch after a save reloads the fields.
              key={`${identity.channel}:${identity.externalId}`}
              label={label}
              initial={identity}
              submitLabel={t("representative.customers.saveIdentity")}
              pending={update.isPending}
              onSubmit={(value) =>
                update.mutate({ id: customer.id, identityId: identity.id, ...value })
              }
            />
            <p className="text-xs text-muted-foreground">
              {t(
                identity.verified
                  ? "representative.customers.verified"
                  : "representative.customers.unverified",
              )}
            </p>
          </div>
        ))}
        <IdentityFields
          // Remounted empty once an identity is added, and kept as typed when the add is refused.
          key={customer.identities.length}
          label={`${label} (new)`}
          initial={{ channel: "", externalId: "" }}
          submitLabel={t("representative.customers.addIdentity")}
          pending={add.isPending}
          onSubmit={(value) => add.mutate({ id: customer.id, ...value })}
        />
      </div>
    </li>
  );
}

function NewCustomerForm() {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [externalId, setExternalId] = useState("");
  const create = useCreateCustomer({
    onSuccess: async () => {
      await refresh();
      setName("");
      setChannel("");
      setExternalId("");
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ ...(name.trim() && { name }), channel, externalId });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="customer-name">{t("representative.customers.name")}</Label>
        <Input
          id="customer-name"
          value={name}
          placeholder={t("representative.customers.namePlaceholder")}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="customer-channel">{t("representative.customers.channel")}</Label>
        <Input
          id="customer-channel"
          value={channel}
          maxLength={64}
          onChange={(event) => setChannel(event.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="customer-external-id">{t("representative.customers.externalId")}</Label>
        <Input
          id="customer-external-id"
          value={externalId}
          maxLength={512}
          onChange={(event) => setExternalId(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        disabled={create.isPending || channel.trim() === "" || externalId.trim() === ""}
      >
        {t("representative.customers.create")}
      </Button>
    </form>
  );
}

/**
 * Customers: the owner's list, a form to add one by hand, and each one's name, identities and
 * block. They belong to the owner, not to one Representative. The Host mounts it at `/customers`.
 */
export function CustomersPage() {
  const { t } = useI18n();
  const customers = useCustomers();
  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t("representative.customers.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("representative.customers.intro")}</p>
      </div>
      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("representative.customers.add")}</h2>
        <NewCustomerForm />
      </section>
      {customers.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("representative.customers.none")}</p>
      )}
      <ul className="divide-y overflow-hidden rounded-xl border empty:hidden">
        {customers.data?.map((customer) => (
          <CustomerCard
            // Keyed by its stored name, so a refetch after a save reloads the name field.
            key={`${customer.id}:${customer.name ?? ""}`}
            customer={customer}
          />
        ))}
      </ul>
    </main>
  );
}
