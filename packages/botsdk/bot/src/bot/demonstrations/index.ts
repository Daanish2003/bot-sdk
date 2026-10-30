// The demonstrations module's entry point (#889): other modules import it only through this file.
import { demonstrationCheckJob } from "./demonstration";
import { demonstrationCaptureJob } from "./demonstration-capture";
import { demonstrationDraftJob, demonstrationRetentionJob } from "./demonstration-draft";

/** The demonstrations module's jobs. */
export const demonstrationJobs = [
  demonstrationCheckJob,
  demonstrationCaptureJob,
  demonstrationDraftJob,
  demonstrationRetentionJob,
];

export {
  actOnDemonstration,
  computerUseHelperHoldsScreenError,
  demonstrationEndedWhileOpeningError,
  demonstrationRunningError,
  stopUserDemonstrations,
  watchUserTool,
  watchUserToolName,
} from "./demonstration";
export {
  demonstrationEventBlobKey,
  demonstrationEventLimit,
  demonstrationSteps,
  maskedValue,
} from "./demonstration-capture";
export {
  demonstrationDraftMarker,
  type Drafted,
  draftedSkill,
  draftSkill,
} from "./demonstration-draft";
