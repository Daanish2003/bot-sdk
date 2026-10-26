import { implement } from "@orpc/server";

import type { Context } from "../../../../core/server/context";
import { requireAuth } from "../../../../core/server/procedures";
import type { DemonstrationAction } from "../../shared/demonstration";
import { botContract } from "../../shared/contract";
import { botChanges } from "../changes";

/*
 * The `bot` plugin's routers: they implement the Bot core's contract (`shared/contract.ts`), one
 * router per namespace, each procedure a one-line call of the domain method with the signed-in
 * user's id. Served under `<basePath>/rpc/<namespace>`. The `channels` namespace is the email
 * Channel's (`channel.ts`).
 */

const os = implement(botContract).$context<Context>().use(requireAuth);

/** A procedure that applies `action` to one of the user's Demonstrations. */
const demonstrationAction = (action: Exclude<DemonstrationAction, "view">) =>
  os.demonstrations[action].handler(({ context, input }) =>
    context.sdk.demonstrations[action]({ userId: context.user.id, ...input }),
  );

const bots = os.bots.router({
  create: os.bots.create.handler(({ context, input }) =>
    context.sdk.bots.create({ userId: context.user.id, ...input }),
  ),
  list: os.bots.list.handler(({ context }) => context.sdk.bots.list({ userId: context.user.id })),
  get: os.bots.get.handler(({ context, input }) =>
    context.sdk.bots.get({ userId: context.user.id, ...input }),
  ),
  changes: os.bots.changes.handler(({ context, input }) =>
    botChanges(context.sdk, context.user.id, input.botId, input.since),
  ),
  send: os.bots.send.handler(({ context, input }) =>
    context.sdk.bots.send({ userId: context.user.id, ...input }),
  ),
  upload: os.bots.upload.handler(({ context, input }) =>
    context.sdk.bots.upload({ userId: context.user.id, ...input }),
  ),
  stop: os.bots.stop.handler(({ context, input }) =>
    context.sdk.bots.stop({ userId: context.user.id, ...input }),
  ),
  warm: os.bots.warm.handler(({ context, input }) =>
    context.sdk.bots.warm({ userId: context.user.id, ...input }),
  ),
  choose: os.bots.choose.handler(({ context, input }) =>
    context.sdk.bots.choose({ userId: context.user.id, ...input }),
  ),
  react: os.bots.react.handler(({ context, input }) =>
    context.sdk.bots.react({ userId: context.user.id, ...input }),
  ),
});

const routines = os.routines.router({
  list: os.routines.list.handler(({ context, input }) =>
    context.sdk.routines.list({ userId: context.user.id, ...input }),
  ),
  approve: os.routines.approve.handler(({ context, input }) =>
    context.sdk.routines.approve({ userId: context.user.id, ...input }),
  ),
  decline: os.routines.decline.handler(({ context, input }) =>
    context.sdk.routines.decline({ userId: context.user.id, ...input }),
  ),
  pause: os.routines.pause.handler(({ context, input }) =>
    context.sdk.routines.pause({ userId: context.user.id, ...input }),
  ),
  resume: os.routines.resume.handler(({ context, input }) =>
    context.sdk.routines.resume({ userId: context.user.id, ...input }),
  ),
  delete: os.routines.delete.handler(({ context, input }) =>
    context.sdk.routines.delete({ userId: context.user.id, ...input }),
  ),
  rotate: os.routines.rotate.handler(({ context, input }) =>
    context.sdk.routines.rotate({ userId: context.user.id, ...input }),
  ),
});

const checkIns = os.checkIns.router({
  list: os.checkIns.list.handler(({ context, input }) =>
    context.sdk.checkIns.list({ userId: context.user.id, ...input }),
  ),
  cancel: os.checkIns.cancel.handler(({ context, input }) =>
    context.sdk.checkIns.cancel({ userId: context.user.id, ...input }),
  ),
});

const helpers = os.helpers.router({
  list: os.helpers.list.handler(({ context, input }) =>
    context.sdk.helpers.list({ userId: context.user.id, ...input }),
  ),
  done: os.helpers.done.handler(({ context, input }) =>
    context.sdk.helpers.done({ userId: context.user.id, ...input }),
  ),
  stop: os.helpers.stop.handler(({ context, input }) =>
    context.sdk.helpers.stop({ userId: context.user.id, ...input }),
  ),
});

const reviews = os.reviews.router({
  list: os.reviews.list.handler(({ context, input }) =>
    context.sdk.reviews.list({ userId: context.user.id, ...input }),
  ),
  allow: os.reviews.allow.handler(({ context, input }) =>
    context.sdk.reviews.allow({ userId: context.user.id, ...input }),
  ),
  deny: os.reviews.deny.handler(({ context, input }) =>
    context.sdk.reviews.deny({ userId: context.user.id, ...input }),
  ),
});

const secrets = os.secrets.router({
  save: os.secrets.save.handler(({ context, input }) =>
    context.sdk.secrets.save({ ...input, userId: context.user.id }),
  ),
  list: os.secrets.list.handler(({ context }) =>
    context.sdk.secrets.list({ userId: context.user.id }),
  ),
  delete: os.secrets.delete.handler(({ context, input }) =>
    context.sdk.secrets.delete({ ...input, userId: context.user.id }),
  ),
});

const demonstrations = os.demonstrations.router({
  pause: demonstrationAction("pause"),
  resume: demonstrationAction("resume"),
  done: demonstrationAction("done"),
  cancel: demonstrationAction("cancel"),
  view: os.demonstrations.view.handler(({ context, input }) =>
    context.sdk.demonstrations.view({ userId: context.user.id, ...input }),
  ),
  steps: os.demonstrations.steps.handler(({ context, input }) =>
    context.sdk.demonstrations.steps({ userId: context.user.id, ...input }),
  ),
});

const computer = os.computer.router({
  view: os.computer.view.handler(({ context, input }) =>
    context.sdk.screens.view({ ...input, userId: context.user.id }),
  ),
  control: os.computer.control.handler(({ context, input }) =>
    context.sdk.screens.control({ ...input, userId: context.user.id }),
  ),
});

/** The `bot` plugin's routers, one per namespace, served under `<basePath>/rpc/<namespace>`. */
export const botPluginRouter = {
  bots,
  routines,
  checkIns,
  helpers,
  reviews,
  secrets,
  demonstrations,
  computer,
};
