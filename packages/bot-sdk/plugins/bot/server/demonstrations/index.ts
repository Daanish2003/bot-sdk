// The demonstrations module's entry point (#889): other modules import it only through this file.
import "./demonstration-capture";
import "./demonstration-draft";

export {
  actOnDemonstration,
  computerUseHelperHoldsScreenError,
  demonstrationEndedWhileOpeningError,
  demonstrationRunningError,
  stopUserDemonstrations,
  watchUserTool,
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
