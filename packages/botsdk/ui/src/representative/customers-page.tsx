import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { toast } from "sonner";

import { useI18n } from "@botsdk/react/provider";
import { serverErrorText } from "@botsdk/react/rpc-error";
import {
  useAddCustomerIdentity,
  useAddProfileField,
  useCreateCustomer,
  useCustomerMerges,
  useCustomers,
  useMergeCustomer,
  useProfileFields,
  useRefreshRepresentatives,
  useRemoveProfileField,
  useRenameCustomer,
  useRenameProfileField,
  useSetCustomerBlocked,
  useSetCustomerProfileValue,
  useUndoCustomerMerge,
  useUpdateCustomerIdentity,
} from "@botsdk/representative/react";
import {
  correctableFixedFields,
  type CustomerMergeView,
  type CustomerView,
  maxProfileFieldNameLength,
  maxProfileValueLength,
  type ProfileFieldView,
  type ProfileValueView,
} from "@botsdk/representative/client";

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

/** Merges this Customer into another of the owner's, which is what is left. It can be undone. */
function MergeInto({
  customer,
  label,
  others,
}: {
  customer: CustomerView;
  label: string;
  others: CustomerView[];
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [intoId, setIntoId] = useState("");
  const merge = useMergeCustomer({
    onSuccess: () => refresh(),
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className="h-8 w-56 rounded-md border bg-background px-2 text-sm"
        aria-label={t("representative.customers.mergeInto", { name: label })}
        value={intoId}
        onChange={(event) => setIntoId(event.target.value)}
      >
        <option value="">{t("representative.customers.mergeChoose")}</option>
        {others.map((other) => (
          <option key={other.id} value={other.id}>
            {`${other.name ?? t("representative.customers.unnamed")} · ${other.identities[0]?.externalId ?? ""}`}
          </option>
        ))}
      </select>
      <Button
        variant="outline"
        size="sm"
        disabled={merge.isPending || intoId === ""}
        aria-label={t("representative.customers.mergeOf", { name: label })}
        onClick={() => merge.mutate({ id: customer.id, intoId })}
      >
        {t("representative.customers.merge")}
      </Button>
    </div>
  );
}

/** One merge: what moved, who did it, and Undo while it stands. */
function MergeRow({ merge }: { merge: CustomerMergeView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const undo = useUndoCustomerMerge({
    onSuccess: () => refresh(),
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const names = {
    from: merge.absorbed.name ?? t("representative.customers.unnamed"),
    into: merge.survivor.name ?? t("representative.customers.unnamed"),
  };
  return (
    <li data-merge={merge.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
      <span className="font-medium">{t("representative.customers.mergeRow", names)}</span>
      <span className="text-xs text-muted-foreground">
        {t(
          merge.how === "code"
            ? "representative.customers.mergeByCode"
            : "representative.customers.mergeByOwner",
        )}
      </span>
      <span className="text-xs text-muted-foreground">
        {merge.identities.map((identity) => identity.externalId).join(", ")}
      </span>
      {merge.undoneAt ? (
        <span className="ml-auto text-xs font-medium">
          {t("representative.customers.mergeUndone")}
        </span>
      ) : (
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={undo.isPending}
          aria-label={t("representative.customers.mergeUndoOf", names)}
          onClick={() => undo.mutate({ id: merge.id })}
        >
          {t("representative.customers.mergeUndo")}
        </Button>
      )}
    </li>
  );
}

/** Where a profile value came from, whether it is confirmed, and when it was recorded. */
function ProfileValueMeta({ value }: { value: ProfileValueView | undefined }) {
  const { t } = useI18n();
  if (!value) return null;
  return (
    <p data-status={value.status} className="text-xs text-muted-foreground">
      {t("representative.customers.profileMeta", {
        source: t(
          value.source === "owner"
            ? "representative.customers.profileSourceOwner"
            : "representative.customers.profileSourceCustomer",
        ),
        status: t(
          value.status === "confirmed"
            ? "representative.customers.profileConfirmed"
            : "representative.customers.profileClaimed",
        ),
        date: value.recordedAt.toLocaleDateString(),
      })}
    </p>
  );
}

/** One field of a Customer's profile, with its value's meta. Saving it confirms it as the owner's. */
function ProfileRow({
  customerId,
  field,
  label,
  who,
  value,
}: {
  customerId: string;
  field: string;
  label: string;
  who: string;
  value: ProfileValueView | undefined;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const set = useSetCustomerProfileValue({
    onSuccess: async () => {
      await refresh();
      toast.success(t("representative.customers.saved"));
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  const [text, setText] = useState(value?.value ?? "");
  const unchanged = text.trim() === (value?.value ?? "") && value?.status !== "claimed";
  return (
    <form
      data-profile-field={field}
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault();
        set.mutate({ id: customerId, field, value: text });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-32 truncate text-xs">{label}</span>
        <Input
          className="w-56"
          aria-label={t("representative.customers.profileValueOf", { field: label, name: who })}
          value={text}
          maxLength={maxProfileValueLength}
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={set.isPending || unchanged}
          aria-label={t("representative.customers.profileSaveOf", { field: label, name: who })}
        >
          {t("representative.customers.profileSave")}
        </Button>
      </div>
      <ProfileValueMeta value={value} />
    </form>
  );
}

/** A Customer's profile, below the name: the other fixed fields, then the owner's own. */
function ProfileSection({
  customer,
  label,
  fields,
}: {
  customer: CustomerView;
  label: string;
  fields: ProfileFieldView[];
}) {
  const { t } = useI18n();
  const fixedNames = {
    language: t("representative.customers.profileLanguage"),
    preferred_channel: t("representative.customers.profilePreferredChannel"),
    address: t("representative.customers.profileAddress"),
  };
  const rows = [
    ...correctableFixedFields.map((field) => ({ field, name: fixedNames[field] as string })),
    ...fields.map(({ id, name }) => ({ field: id as string, name })),
  ];
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">
        {t("representative.customers.profile")}
      </h3>
      {rows.map(({ field, name }) => {
        const value = customer.profile.find((each) => each.field === field);
        return (
          <ProfileRow
            // Keyed by what is stored, so a refetch after a save reloads the field.
            key={`${field}:${value?.value ?? ""}`}
            customerId={customer.id}
            field={field}
            label={name}
            who={label}
            value={value}
          />
        );
      })}
    </div>
  );
}

function CustomerCard({
  customer,
  others,
  fields,
}: {
  customer: CustomerView;
  others: CustomerView[];
  fields: ProfileFieldView[];
}) {
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
  const nameValue = customer.profile.find((each) => each.field === "name");
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
          disabled={
            rename.isPending ||
            (name.trim() === (customer.name ?? "") && nameValue?.status !== "claimed")
          }
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
      <ProfileValueMeta value={nameValue} />
      {customer.blocked && (
        <p className="text-xs text-muted-foreground">{t("representative.customers.blockedHelp")}</p>
      )}
      <ProfileSection customer={customer} label={label} fields={fields} />
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
      {others.length > 0 && <MergeInto customer={customer} label={label} others={others} />}
    </li>
  );
}

/** One of the owner's own fields: renamed with a button, or removed with every Customer's value. */
function ProfileFieldRow({ field }: { field: ProfileFieldView }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const options = {
    onSuccess: () => refresh(),
    onError: (error: unknown) => toast.error(serverErrorText(i18n, error)),
  };
  const rename = useRenameProfileField(options);
  const remove = useRemoveProfileField(options);
  const [name, setName] = useState(field.name);
  return (
    <li data-profile-field-row={field.name} className="flex flex-wrap items-center gap-2 p-3">
      <Input
        className="w-56"
        aria-label={t("representative.customers.fieldNameOf", { name: field.name })}
        value={name}
        maxLength={maxProfileFieldNameLength}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={rename.isPending || name.trim() === "" || name.trim() === field.name}
        aria-label={t("representative.customers.fieldRenameOf", { name: field.name })}
        onClick={() => rename.mutate({ id: field.id, name })}
      >
        {t("representative.customers.fieldRename")}
      </Button>
      <Button
        className="ml-auto"
        variant="destructive"
        size="sm"
        disabled={remove.isPending}
        aria-label={t("representative.customers.fieldRemoveOf", { name: field.name })}
        onClick={() => remove.mutate({ id: field.id })}
      >
        {t("representative.customers.fieldRemove")}
      </Button>
    </li>
  );
}

/** The fields the owner defined for all their Customers' profiles. */
function ProfileFields({ fields }: { fields: ProfileFieldView[] }) {
  const i18n = useI18n();
  const { t } = i18n;
  const refresh = useRefreshRepresentatives();
  const [name, setName] = useState("");
  const add = useAddProfileField({
    onSuccess: async () => {
      await refresh();
      setName("");
    },
    onError: (error) => toast.error(serverErrorText(i18n, error)),
  });
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("representative.customers.fields")}</h2>
      <p className="text-sm text-muted-foreground">{t("representative.customers.fieldsHelp")}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate({ name });
        }}
      >
        <Input
          className="w-56"
          aria-label={t("representative.customers.fieldNew")}
          value={name}
          maxLength={maxProfileFieldNameLength}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={add.isPending || name.trim() === ""}
        >
          {t("representative.customers.fieldAdd")}
        </Button>
      </form>
      <ul className="divide-y overflow-hidden rounded-xl border empty:hidden">
        {fields.map((field) => (
          // Keyed by what is stored, so a refetch after a save reloads the field.
          <ProfileFieldRow key={`${field.id}:${field.name}`} field={field} />
        ))}
      </ul>
    </section>
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
  const all = customers.data ?? [];
  const merges = useCustomerMerges();
  const fields = useProfileFields().data ?? [];
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
      <ProfileFields fields={fields} />
      {customers.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("representative.customers.none")}</p>
      )}
      <ul className="divide-y overflow-hidden rounded-xl border empty:hidden">
        {customers.data?.map((customer) => (
          <CustomerCard
            // Keyed by its stored name, so a refetch after a save reloads the name field.
            key={`${customer.id}:${customer.name ?? ""}`}
            customer={customer}
            others={all.filter((other) => other.id !== customer.id)}
            fields={fields}
          />
        ))}
      </ul>
      {merges.data && merges.data.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium">{t("representative.customers.merges")}</h2>
          <ul className="divide-y overflow-hidden rounded-xl border">
            {merges.data.map((merge) => (
              <MergeRow key={merge.id} merge={merge} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
