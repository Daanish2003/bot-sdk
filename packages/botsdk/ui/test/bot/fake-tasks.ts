import type { BotCheckIn } from "@botsdk/client/bot/check-in";
import { type BotHelper, isLiveHelper } from "@botsdk/client/bot/helper";
import type { BotRoutine } from "@botsdk/client/bot/routine";
import type { BotTasks, DoneHelper, TaskTrigger } from "@botsdk/client/bot/tasks";

/**
 * What the server's `bots.tasks` answers for the lists a test's stand-in server holds: live Helpers
 * in progress, the others in Done, every Routine and pending Check-in scheduled, fired Check-ins in
 * Done. `turn`, `waiting` and `skipped` are the running Turn, the Triggers waiting in the queue and
 * the skipped ones.
 */
export function tasksOf({
  helpers = [],
  routines = [],
  checkIns = [],
  turn = null,
  waiting = [],
  skipped = [],
}: {
  helpers?: BotHelper[];
  routines?: BotRoutine[];
  checkIns?: BotCheckIn[];
  turn?: BotTasks["inProgress"]["turn"];
  waiting?: TaskTrigger[];
  skipped?: TaskTrigger[];
} = {}): BotTasks {
  return {
    inProgress: { turn, helpers: helpers.filter((helper) => isLiveHelper(helper.status)) },
    scheduled: {
      triggers: waiting,
      routines: [...routines],
      checkIns: checkIns.filter((checkIn) => checkIn.state === "pending"),
    },
    done: {
      helpers: helpers
        .filter((helper) => !isLiveHelper(helper.status))
        .map((helper): DoneHelper => ({ ...helper, endedAt: helper.startedAt })),
      checkIns: checkIns.filter((checkIn) => checkIn.state === "fired"),
      skipped,
    },
  };
}
