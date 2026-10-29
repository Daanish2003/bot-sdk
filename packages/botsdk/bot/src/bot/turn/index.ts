// The turn module's entry point (#889): other modules import it only through this file.
import { approvedCallJob } from "./approved-call";
import { summarizeAwayJob } from "./summary-away";
import { botTurnJob } from "./turn";

/** The turn module's jobs. */
export const turnJobs = [botTurnJob, summarizeAwayJob, approvedCallJob];

export { receiveEmail } from "./email-inbound";
export { emailText } from "./email-text";
export { pauseBot, resetBot, resumeBot } from "./pause";
export { sendToBot, stopBot, stopUserTurns } from "./turn";
