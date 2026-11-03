import { isChannelAnswerable } from "@botsdk/client/bot/rich-control";
import type { BotMessage } from "@botsdk/client/bot/turn";
import type { Block } from "@botsdk/client/message-format";

import type { FileBytes } from "./email-out";
import type { MessagingButtons, OutboundMessage } from "./messaging";

/** The option a choice's Other button carries back. */
export const otherOption = "other";

/** The options an Approval's buttons carry back. */
export const approveOption = "approve";
export const denyOption = "deny";

const line = (text: string): Block => ({ type: "paragraph", children: [{ type: "text", text }] });

const list = (ordered: boolean, items: string[]): Block => ({
  type: "list",
  ordered,
  start: 1,
  items: items.map((item) => [line(item)]),
});

/**
 * One Bot Message as a messaging Channel's outbound Message (spec #1044, "How a Message shows on
 * Telegram"): its text, then its Rich control (`control`) reduced the way email reduces it. A choice is a numbered
 * list with one button per option (a typed number answers too) and Other when offered, an Approval
 * has Approve and Deny (but a release Approval, answered only on its page, is a link), a Secret request is only a link into the app, and the Computer and
 * Show me cards are one line and a link. Buttons carry the Message's `id` as their control. `files`
 * are sent when their bytes are known and within `uploadLimit`; the rest are listed with a link.
 * `appUrl` is the Bot's page, or `null` when the Host has none (no link is written).
 */
export function messagingBody(
  message: Pick<BotMessage, "id" | "text" | "control">,
  {
    appUrl,
    files = [],
    uploadLimit,
  }: { appUrl: string | null; files?: FileBytes[]; uploadLimit: number },
): Pick<OutboundMessage, "text" | "control" | "buttons" | "files"> {
  const lines: Block[] = [];
  let buttons: MessagingButtons | undefined;
  let sent: OutboundMessage["files"];
  const control = message.control;
  const link = (lead: string): Block =>
    appUrl
      ? {
          type: "paragraph",
          children: [{ type: "link", href: appUrl, children: [{ type: "text", text: lead }] }],
        }
      : line(lead);
  switch (control?.kind) {
    case "choice":
      if (control.answer) break;
      lines.push(
        list(true, [
          ...control.options,
          ...(control.other ? ["Other: reply with your own answer"] : []),
        ]),
      );
      buttons = {
        control: message.id,
        options: [
          ...control.options.map((label, index) => ({ option: String(index), label })),
          ...(control.other ? [{ option: otherOption, label: "Other" }] : []),
        ],
      };
      break;
    case "files": {
      const left: string[] = [];
      for (const { file, bytes } of files) {
        if (bytes && file.size <= uploadLimit) {
          (sent ??= []).push({ name: file.name, contentType: file.mediaType, content: bytes });
        } else left.push(file.name);
      }
      if (left.length > 0) {
        lines.push(list(false, left), link("Download in the app"));
      }
      break;
    }
    case "secret":
      lines.push(link("Enter it securely in the app"));
      break;
    case "computer":
      lines.push(link("Take over the Computer in the app"));
      break;
    case "demonstration":
      lines.push(link("Show me in the app"));
      break;
    case "release_approval":
    case "fact_approval":
      lines.push(link("Review it in the app"));
      break;
    case undefined:
      break;
    default:
      if (isChannelAnswerable(control?.kind)) {
        buttons = {
          control: message.id,
          options: [
            { option: approveOption, label: "Approve" },
            { option: denyOption, label: "Deny" },
          ],
        };
        lines.push(line("Reply yes or no, or answer in the app."));
      } else lines.push(link("Open it in the app"));
  }
  return {
    text: message.text,
    ...(lines.length > 0 && { control: lines }),
    ...(buttons && { buttons }),
    ...(sent && { files: sent }),
  };
}
