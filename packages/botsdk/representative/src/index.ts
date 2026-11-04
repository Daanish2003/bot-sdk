import { representativeFeature, type RepresentativeOptions } from "./server/plugin";

/** The `representative` feature. A Host turns it on with `representative()` in `features`. */
export const representative = (options?: RepresentativeOptions) => representativeFeature(options);
export type { RepresentativeOptions };
export type { RepresentativeApi } from "./server/api";
export type { ConvertDocument, KnowledgeFiles } from "./server/documents";
