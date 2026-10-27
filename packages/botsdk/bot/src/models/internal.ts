// The models service's entry point inside the SDK (#889): the core imports it only through this
// file. index.ts stays the public package export.
export { adaptersOf, imageRequestFor } from "./adapters";
export { listAvailableModels } from "./available-models";
export { withCacheControl } from "./cache-control";
export { chatgptPlanFetch } from "./chatgpt-plan";
export { checkCredentials } from "./credentials/check";
export {
  type ModelCall,
  resolvedServices,
  shownLinkedPlan,
  type ToolCall,
} from "./credentials/resolve";
export {
  deleteCredentials,
  listCredentials,
  loadCredentials,
  rotateCredentialKeys,
  saveCredentials,
} from "./credentials/store";
export { fakeImageAdapter, fakePngBase64 } from "./fake-image-adapter";
export type { ResolvedImageModel } from "./image-models";
export { ImageRefusedError } from "./image-refused";
export { ollamaModels, openRouterModels } from "./live-models";
export {
  freeMeter,
  freeModelMeter,
  hostModelMeter,
  hostSearchMeter,
  imageMeter,
  type ModelMeter,
  type ModelUsage,
} from "./meter";
export {
  models,
  type ModelsApi,
  type ModelsOptions,
  modelsOver,
  type ModelsPlugin,
  productionDeps,
} from "./plugin";
export { quotaLookup, readQuota } from "./quota";
export { addUsage, promptCharactersOf, reportedUsageOf } from "./run-usage";
export { modelsDeps } from "./state";
export type {
  Credentials,
  HostProvider,
  LinkedCredentials,
  LinkedCredentialsHook,
  ModelProvider,
  ModelProviders,
  ModelsDeps,
  QuotaSetting,
} from "./types";
