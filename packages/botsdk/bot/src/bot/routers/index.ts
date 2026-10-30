import { botContract } from "@botsdk/client/bot/contract";
import type { DemonstrationAction } from "@botsdk/client/bot/demonstration";
import { implement } from "@orpc/server";

import type { Context } from "../../context";
import { requireAuth } from "../../procedures";

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
    context.sdk.demonstrations[action]({ ...input, userId: context.user.id }),
  );

const bots = os.bots.router({
  create: os.bots.create.handler(({ context, input }) =>
    context.sdk.bots.create({ ...input, userId: context.user.id }),
  ),
  list: os.bots.list.handler(({ context }) => context.sdk.bots.list({ userId: context.user.id })),
  get: os.bots.get.handler(({ context, input }) =>
    context.sdk.bots.get({ ...input, userId: context.user.id }),
  ),
  send: os.bots.send.handler(({ context, input }) =>
    context.sdk.bots.send({ ...input, userId: context.user.id }),
  ),
  upload: os.bots.upload.handler(({ context, input }) =>
    context.sdk.bots.upload({ ...input, userId: context.user.id }),
  ),
  stop: os.bots.stop.handler(({ context, input }) =>
    context.sdk.bots.stop({ ...input, userId: context.user.id }),
  ),
  pause: os.bots.pause.handler(({ context, input }) =>
    context.sdk.bots.pause({ ...input, userId: context.user.id }),
  ),
  resume: os.bots.resume.handler(({ context, input }) =>
    context.sdk.bots.resume({ ...input, userId: context.user.id }),
  ),
  reset: os.bots.reset.handler(({ context, input }) =>
    context.sdk.bots.reset({ ...input, userId: context.user.id }),
  ),
  tasks: os.bots.tasks.handler(({ context, input }) =>
    context.sdk.bots.tasks({ ...input, userId: context.user.id }),
  ),
  warm: os.bots.warm.handler(({ context, input }) =>
    context.sdk.bots.warm({ ...input, userId: context.user.id }),
  ),
  choose: os.bots.choose.handler(({ context, input }) =>
    context.sdk.bots.choose({ ...input, userId: context.user.id }),
  ),
  react: os.bots.react.handler(({ context, input }) =>
    context.sdk.bots.react({ ...input, userId: context.user.id }),
  ),
});

const conversations = os.conversations.router({
  changes: os.conversations.changes.handler(({ context, input }) =>
    context.sdk.conversations.changes({ ...input, userId: context.user.id }),
  ),
});

const routines = os.routines.router({
  list: os.routines.list.handler(({ context, input }) =>
    context.sdk.routines.list({ ...input, userId: context.user.id }),
  ),
  approve: os.routines.approve.handler(({ context, input }) =>
    context.sdk.routines.approve({ ...input, userId: context.user.id }),
  ),
  decline: os.routines.decline.handler(({ context, input }) =>
    context.sdk.routines.decline({ ...input, userId: context.user.id }),
  ),
  pause: os.routines.pause.handler(({ context, input }) =>
    context.sdk.routines.pause({ ...input, userId: context.user.id }),
  ),
  resume: os.routines.resume.handler(({ context, input }) =>
    context.sdk.routines.resume({ ...input, userId: context.user.id }),
  ),
  delete: os.routines.delete.handler(({ context, input }) =>
    context.sdk.routines.delete({ ...input, userId: context.user.id }),
  ),
  edit: os.routines.edit.handler(({ context, input }) =>
    context.sdk.routines.edit({ ...input, userId: context.user.id }),
  ),
  rotate: os.routines.rotate.handler(({ context, input }) =>
    context.sdk.routines.rotate({ ...input, userId: context.user.id }),
  ),
});

const checkIns = os.checkIns.router({
  list: os.checkIns.list.handler(({ context, input }) =>
    context.sdk.checkIns.list({ ...input, userId: context.user.id }),
  ),
  cancel: os.checkIns.cancel.handler(({ context, input }) =>
    context.sdk.checkIns.cancel({ ...input, userId: context.user.id }),
  ),
  edit: os.checkIns.edit.handler(({ context, input }) =>
    context.sdk.checkIns.edit({ ...input, userId: context.user.id }),
  ),
});

const triggers = os.triggers.router({
  skip: os.triggers.skip.handler(({ context, input }) =>
    context.sdk.triggers.skip({ ...input, userId: context.user.id }),
  ),
});

const helpers = os.helpers.router({
  list: os.helpers.list.handler(({ context, input }) =>
    context.sdk.helpers.list({ ...input, userId: context.user.id }),
  ),
  done: os.helpers.done.handler(({ context, input }) =>
    context.sdk.helpers.done({ ...input, userId: context.user.id }),
  ),
  stop: os.helpers.stop.handler(({ context, input }) =>
    context.sdk.helpers.stop({ ...input, userId: context.user.id }),
  ),
});

const reviews = os.reviews.router({
  list: os.reviews.list.handler(({ context, input }) =>
    context.sdk.reviews.list({ ...input, userId: context.user.id }),
  ),
  allow: os.reviews.allow.handler(({ context, input }) =>
    context.sdk.reviews.allow({ ...input, userId: context.user.id }),
  ),
  deny: os.reviews.deny.handler(({ context, input }) =>
    context.sdk.reviews.deny({ ...input, userId: context.user.id }),
  ),
});

const notifications = os.notifications.router({
  get: os.notifications.get.handler(({ context }) =>
    context.sdk.notifications.get({ userId: context.user.id }),
  ),
  update: os.notifications.update.handler(({ context, input }) =>
    context.sdk.notifications.update({ ...input, userId: context.user.id }),
  ),
  push: {
    key: os.notifications.push.key.handler(({ context }) => context.sdk.notifications.pushKey()),
    subscribe: os.notifications.push.subscribe.handler(({ context, input }) =>
      context.sdk.notifications.subscribe({ ...input, userId: context.user.id }),
    ),
    unsubscribe: os.notifications.push.unsubscribe.handler(({ context, input }) =>
      context.sdk.notifications.unsubscribe({ ...input, userId: context.user.id }),
    ),
  },
});

const rules = os.rules.router({
  list: os.rules.list.handler(({ context }) => context.sdk.rules.list({ userId: context.user.id })),
  neverAllowed: os.rules.neverAllowed.handler(({ context }) => context.sdk.rules.neverAllowed()),
  create: os.rules.create.handler(({ context, input }) =>
    context.sdk.rules.create({ ...input, userId: context.user.id }),
  ),
  update: os.rules.update.handler(({ context, input }) =>
    context.sdk.rules.update({ ...input, userId: context.user.id }),
  ),
  delete: os.rules.delete.handler(({ context, input }) =>
    context.sdk.rules.delete({ ...input, userId: context.user.id }),
  ),
  approve: os.rules.approve.handler(({ context, input }) =>
    context.sdk.rules.approve({ ...input, userId: context.user.id }),
  ),
  deny: os.rules.deny.handler(({ context, input }) =>
    context.sdk.rules.deny({ ...input, userId: context.user.id }),
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
    context.sdk.demonstrations.view({ ...input, userId: context.user.id }),
  ),
  steps: os.demonstrations.steps.handler(({ context, input }) =>
    context.sdk.demonstrations.steps({ ...input, userId: context.user.id }),
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

const rooms = os.rooms.router({
  list: os.rooms.list.handler(({ context }) => context.sdk.rooms.list({ userId: context.user.id })),
  get: os.rooms.get.handler(({ context, input }) =>
    context.sdk.rooms.get({ ...input, userId: context.user.id }),
  ),
  create: os.rooms.create.handler(({ context, input }) =>
    context.sdk.rooms.create({ ...input, userId: context.user.id }),
  ),
  send: os.rooms.send.handler(({ context, input }) =>
    context.sdk.rooms.send({ ...input, userId: context.user.id }),
  ),
});

/** The `bot` plugin's routers, one per namespace, served under `<basePath>/rpc/<namespace>`. */
export const botPluginRouter = {
  bots,
  conversations,
  rooms,
  routines,
  checkIns,
  triggers,
  helpers,
  reviews,
  rules,
  notifications,
  secrets,
  demonstrations,
  computer,
};
