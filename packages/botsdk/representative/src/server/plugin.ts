import { defineFeature } from "@botsdk/bot/feature";

import { representativeContract } from "../shared/contract";
import { representativeApi } from "./api";
import { botDraftTools } from "./bot-draft";
import {
  representative,
  representativeCall,
  representativeChannelAccount,
  representativeCustomer,
  representativeCustomerIdentity,
  representativeCustomerMerge,
  representativeDocument,
  representativeEmailAddress,
  representativeFact,
  representativeFactLog,
  representativeGap,
  representativeFactProposal,
  representativeHandOff,
  representativeHeldMessage,
  representativeInboundMail,
  representativeOutboundDecision,
  representativeProfileField,
  representativeProfileValue,
  representativeRelease,
  representativeTestResult,
  representativeThread,
  representativeThreadMail,
  representativeThreadMessage,
  representativeTopic,
  representativeTurn,
  representativeCustomerSummary,
  representativeVerification,
  representativeWidgetKey,
} from "./db/schema";
import {
  exportHeldAccounts,
  heldAccountChannel,
  ownerOfHeldAccount,
  removeHeldAccounts,
} from "./channel-accounts";
import { threadExpiryJob } from "./expiry";
import { threadIdleJob } from "./idle";
import { exportMerges } from "./customer-merge";
import { deleteProfileFields, exportProfileFields } from "./customer-profile";
import { type ChannelOf, type CustomerChannel, proofLinkRoutes } from "./customer-proof";
import { deleteCustomers, exportCustomers } from "./customers";
import { dropProposalsOfBot, factProposalTools } from "./fact-proposals";
import { receiveStranger } from "./strangers";
import { receiveEmail } from "./email-address";
import { deleteFacts, exportFacts } from "./facts";
import { deleteGaps, exportGaps } from "./gaps";
import representativeMigrations from "./migrations.json" with { type: "json" };
import { heldReleaseJob } from "./held-messages";
import { customerDeliveryJob, exportOutboundDecisions } from "./outbound-gate";
import {
  deleteRepresentatives,
  dropApprovalsOfBot,
  exportRepresentatives,
} from "./representatives";
import type { ConvertDocument, KnowledgeFiles } from "./documents";
import { representativeTestJob } from "./tests";
import { deleteTopics, exportTopics } from "./topics";
import { exportCustomerSummaries, customerSummaryJob } from "./customer-summary";
import { draftDueJob } from "./draft-due";
import { assignmentDueJob, ownerWaitJob } from "./stalled-work";
import { stopUserTurns } from "./thread-turns";
import type { ClientIp } from "./web-chat-limits";
import { unsubscribeRoutes } from "./email-unsubscribe";
import { callStartRoutes } from "./call-start";
import { callRequestRoutes } from "./call-request";
import { webChatRoutes, withWebChat } from "./web-chat";
import { webChatCodeRoutes } from "./web-chat-code";
import { type WidgetSessionCheck, widgetSessionRoutes } from "./widget-key";
import { handOffEndedJob, limitCheckJob, representativeTurnJob } from "./turn";

export type RepresentativeOptions = {
  /**
   * At most this many Representative Turns run at once in one process; 50 by default. Size it to at
   * least arrivals per second × Turn length in seconds.
   */
  concurrency?: number;
  /**
   * At most this many messages go to Customers at once in one process, and as many held messages are
   * released, each in a budget of its own, so Customers don't queue behind the shared default of 2. 20
   * by default. Size it to at least messages per second × the seconds a platform takes to accept one.
   */
  deliveryConcurrency?: number;
  /**
   * Reads an uploaded PDF or DOCX as text, refusing what it can't, as `convertDocument` from
   * `@botsdk/knowledge/convert` does with Knowledge's limits. Without it, documents upload as Markdown
   * or plain text only. Asked of the Host because the feature has no Computer and no other use for
   * the parsers.
   */
  convertDocument?: ConvertDocument;
  /**
   * Lets the owner pick Knowledge files for a draft: `sdk.knowledge`'s `list` and `read`, passed by a
   * Host that has the Knowledge feature (and so a Computer). The Computer is used only while the owner
   * picks. Without it the picker isn't offered and uploads still work.
   */
  knowledgeFiles?: KnowledgeFiles;
  /**
   * Where the SDK's API is served: the Host's app URL and `basePath`, such as
   * `https://app.example/api/chat`. The signed link in a proof mail opens a page under it. Without
   * it, an email Customer can't be sent a link and so can't verify.
   */
  linkUrl?: string;
  /**
   * Checks each web chat session start request before a session is given: a request it returns false
   * for, or throws on, gets the same refusal as a wrong origin, and a throw is logged. This is where a
   * Host filters public traffic, with the service it chooses (Turnstile, hCaptcha, its own). The SDK
   * ships none, so without this every request from an allowed origin on a live key starts a session.
   */
  widgetSessionCheck?: WidgetSessionCheck;
  /**
   * Says which IP a web chat request came from, so session starts and sends are limited per IP: 10
   * sessions per 10 minutes and 30 messages per minute for each. Return the socket's address, or the
   * header your own proxy sets (`x-real-ip`, say). The SDK reads no forwarded header by default,
   * since anyone can send one and so choose which IP is counted. Left out, or returning nothing for a
   * request, no per-IP limit applies to it: sessions are still limited to 10 messages per minute
   * each, but a program can start sessions without end. Set it when the widget is public. It also
   * limits the live-reply streams of one IP: 120 opened per minute, and 50 held open in a process.
   * Left out, only each session's own cap of 5 open streams applies.
   */
  clientIp?: ClientIp;
};

/**
 * The `representative` feature (spec #1167): restricted agents that speak for the owner's
 * business, each served only through an approved, unchangeable Release. It has no Computer, and
 * Auto-review and Custom Rules, which belong to Bots, don't reach it. A Host turns it on with
 * `representative()` in `features`. Messages reach a Customer through the Channel accounts the
 * Representatives hold, and web chat's visitors by the thread itself; `channel` replaces the accounts
 * for a test, and isn't an option a Host has, so `src/index.ts` doesn't pass it on.
 */
export function representativeFeature(
  options: RepresentativeOptions = {},
  channel?: CustomerChannel,
) {
  const channelOf: ChannelOf = (context) =>
    withWebChat(channel ?? heldAccountChannel(context, options));
  const { deliveryConcurrency = 20 } = options;
  return defineFeature({
    id: "representative",
    needs: [
      "assignments",
      "channelAccounts",
      "counters",
      "factApprovals",
      "models",
      "pages",
      "pubsub",
      "releaseApprovals",
      "representativeLoop",
      "threads",
    ],
    schema: {
      tables: {
        representative,
        representativeCall,
        representativeChannelAccount,
        representativeCustomer,
        representativeCustomerIdentity,
        representativeCustomerMerge,
        representativeDocument,
        representativeEmailAddress,
        representativeFact,
        representativeFactLog,
        representativeGap,
        representativeFactProposal,
        representativeHandOff,
        representativeHeldMessage,
        representativeInboundMail,
        representativeOutboundDecision,
        representativeProfileField,
        representativeProfileValue,
        representativeRelease,
        representativeTestResult,
        representativeThread,
        representativeThreadMail,
        representativeThreadMessage,
        representativeTopic,
        representativeTurn,
        representativeCustomerSummary,
        representativeVerification,
        representativeWidgetKey,
      },
      migrations: representativeMigrations,
    },
    contract: representativeContract,
    api: (context) =>
      representativeApi(
        context,
        options.convertDocument,
        options.knowledgeFiles,
        channelOf(context),
        options.linkUrl,
      ),
    tools: (turn, context) => [
      ...botDraftTools(turn, context),
      ...factProposalTools(turn, context),
    ],
    resetBot: async (botId, userId, context) => {
      await dropApprovalsOfBot(context, botId, userId);
      await dropProposalsOfBot(context, botId, userId);
    },
    stopTurns: (userId, context) => stopUserTurns(context, userId),
    channelAccountOwner: (tx, id) => ownerOfHeldAccount(tx, id),
    onStranger: (message, context) =>
      receiveStranger({ ...context, channel: channelOf(context) }, message),
    onEmail: (mail, context) => receiveEmail({ ...context, channel: channelOf(context) }, mail),
    publicRoutes: [
      ...proofLinkRoutes,
      ...widgetSessionRoutes(options.widgetSessionCheck, options.clientIp),
      ...webChatRoutes(channelOf, options.clientIp),
      ...webChatCodeRoutes(channelOf, options.clientIp),
      ...unsubscribeRoutes(channelOf),
      ...callStartRoutes,
      ...callRequestRoutes,
    ],
    jobs: [
      representativeTurnJob(options.concurrency, channelOf),
      customerDeliveryJob(channelOf, deliveryConcurrency),
      draftDueJob,
      assignmentDueJob(channelOf),
      ownerWaitJob,
      heldReleaseJob(channelOf, deliveryConcurrency),
      handOffEndedJob,
      limitCheckJob,
      representativeTestJob,
      threadIdleJob,
      threadExpiryJob,
      customerSummaryJob,
    ],
    userData: {
      delete: {
        before: async (tx, userId, context) => {
          // Before their Representatives, whose accounts would be left with no holder.
          const heldAccounts = await removeHeldAccounts(context, tx, userId);
          // Representatives first: a Turn receiving a message holds its Representative's row, so once
          // this has passed it, no new Customer can appear behind the delete below.
          await deleteRepresentatives(tx, userId);
          await deleteCustomers(tx, userId);
          await deleteProfileFields(tx, userId);
          await deleteFacts(tx, userId);
          await deleteGaps(tx, userId);
          await deleteTopics(tx, userId);
          return heldAccounts;
        },
        after: async (_userId, heldAccounts, context) => {
          await context.channelAccounts.changed(heldAccounts as string[]);
        },
      },
      export: async (tx, userId) => ({
        representatives: await exportRepresentatives(tx, userId),
        channelAccounts: await exportHeldAccounts(tx, userId),
        customers: await exportCustomers(tx, userId),
        customerMerges: await exportMerges(tx, userId),
        outboundDecisions: await exportOutboundDecisions(tx, userId),
        customerSummaries: await exportCustomerSummaries(tx, userId),
        profileFields: await exportProfileFields(tx, userId),
        ...(await exportFacts(tx, userId)),
        ...(await exportGaps(tx, userId)),
        topics: await exportTopics(tx, userId),
      }),
    },
  });
}
