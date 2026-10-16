import type { ErrorCode } from "../../../core/shared/i18n";
import { rpcError, type ErrorParams } from "../../../core/server/rpc-error";
import { providerLabel, unusableModelMessage } from "../shared/credentials/services";

/**
 * Why a Model can't be used, as a code and params: the key prompt while the user may bring keys
 * (`byok`), else only "pick another". Shared by the chat route and the RPC procedures.
 */
export function unusableModelCode(
  service: string,
  byok: boolean,
): { code: ErrorCode; params: ErrorParams } {
  if (!byok) return { code: "error.pickAnotherModel", params: {} };
  return { code: "error.addKey", params: { label: providerLabel(service) } };
}

/** Why a Model can't be used, as an oRPC error (see `unusableModelCode`). */
export function unusableModelError(service: string, byok: boolean) {
  const { code, params } = unusableModelCode(service, byok);
  const message = byok ? unusableModelMessage(service, byok) : "Pick another Model";
  return rpcError("BAD_REQUEST", code, message, params);
}
