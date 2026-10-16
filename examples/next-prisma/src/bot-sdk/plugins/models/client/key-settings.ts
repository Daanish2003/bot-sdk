import type { CredentialSummary } from "../shared/credentials/services";
import {
  type CredentialService,
  isCredentialService,
  type ProviderId,
  providers,
  toolServices,
} from "../shared/credentials/services";

export type ProviderRowStatus = "verified" | "unverified" | "missing" | "coming_soon";

export type ProviderRow = {
  id: ProviderId;
  label: string;
  status: ProviderRowStatus;
  hint: string | null;
  /** Set when the Provider's credentials can be saved. */
  service: CredentialService | null;
};

/** One Keys & settings row per Provider, in Provider order, from `credentials.list`. */
export function providerRows(credentials: CredentialSummary[]): ProviderRow[] {
  return providers.map(({ id, label }) => {
    if (!isCredentialService(id)) {
      return { id, label, status: "coming_soon", hint: null, service: null };
    }
    const saved = credentials.find((credential) => credential.service === id);
    if (!saved) return { id, label, status: "missing", hint: null, service: id };
    return {
      id,
      label,
      status: saved.verified ? "verified" : "unverified",
      hint: saved.hint,
      service: id,
    };
  });
}

/** A Keys & settings row for a Tool credential. */
export type ToolRow = Omit<ProviderRow, "id"> & { id: string; description: string };

/** One Keys & settings row per Tool that needs a Tool credential, from `credentials.list`. */
export function toolRows(credentials: CredentialSummary[]): ToolRow[] {
  return toolServices.map(({ id, label, description }) => {
    const saved = credentials.find((credential) => credential.service === id);
    return {
      id,
      label,
      description,
      status: saved ? (saved.verified ? "verified" : "unverified") : "missing",
      hint: saved?.hint ?? null,
      service: id,
    };
  });
}
