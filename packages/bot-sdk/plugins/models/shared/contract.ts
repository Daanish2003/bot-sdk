import { oc, type } from "@orpc/contract";
import { z } from "zod";

import {
  type CredentialService,
  credentialServices,
  type CredentialSummary,
  type OpenaiCredentialsState,
  saveCredentialsInput,
} from "./credentials/services";
import type { ListedImageModel } from "./image-models";
import type { ListedModel } from "./models";

/*
 * The `models` namespace's contract (spec #873), with the credentials nested in it and `readQuota`,
 * as `sdk.models` has them. Served under `<basePath>/rpc/models`. Public interface: the browser
 * client is typed by it, and it changes only with the package's semver.
 */

/** The Models a user can pick, and the defaults. */
export type AvailableModels = {
  models: ListedModel[];
  defaultModel: string | null;
  /** The Image Models the user can pick: their own Providers' first, then the Host's (spec #278). */
  imageModels: ListedImageModel[];
  /** The Host's default Image Model, shown when a user picks none (`defaultImageModel`). */
  defaultImageModel: string | null;
  webSearchOnHost: boolean;
};

/** The Quota read: the used percentage, the window and its reset time, never money (ADR 0007). */
export type QuotaReading = { usedPercent: number; window: "day" | "month"; resetsAt: Date };

/** `models.credentials.delete`'s input, besides `userId`. */
export const deleteCredentialsInput = z.object({ service: z.enum(credentialServices) });

/** `models.setImageModel`'s input, besides `userId`. */
export const setImageModelInput = z.object({ imageModel: z.string().nullable() });

/** Provider credentials and Tool credentials. Write-only: the client only ever sees hints (ADR 0003). */
const credentials = {
  list: oc.output(type<CredentialSummary[]>()),
  /** The OpenAI row's state on the Keys page (ADR 0023). */
  openaiState: oc.output(type<OpenaiCredentialsState>()),
  /** Whether the user may bring their own Provider credentials (`byok`, ADR 0007). */
  mode: oc.output(type<{ byok: boolean }>()),
  save: oc
    .input(saveCredentialsInput)
    .output(type<{ service: CredentialService; hint: string; verified: boolean }>()),
  delete: oc.input(deleteCredentialsInput).output(type<void>()),
};

export const modelsContract = {
  models: {
    /** The Models of Providers the user has credentials for, and a new Conversation's default. */
    list: oc.output(type<AvailableModels>()),
    /** The user's Image Model pick, or `null` for the Host's default. */
    imageModel: oc.output(type<{ imageModel: string | null }>()),
    /** Chooses the Image Model Generated images are made with; `null` is the Host's default. */
    setImageModel: oc.input(setImageModelInput).output(type<void>()),
    credentials,
    /**
     * The user's Quota on Host credentials: the used percentage, the window and its reset time,
     * never money. `null` when the Quota is unlimited (ADR 0007).
     */
    readQuota: oc.output(type<QuotaReading | null>()),
  },
};

export type ModelsContract = typeof modelsContract;
