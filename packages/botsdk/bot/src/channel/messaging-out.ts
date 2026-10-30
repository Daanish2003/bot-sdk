import { isApproval } from "@botsdk/client/bot/rich-control";
import type { BotMessage } from "@botsdk/client/bot/turn";

import type { FileBytes } from "./email-out";
import type { MessagingButtons, OutboundMessage } from "./messaging";

/** The option a choice's Other button carries back. */
export const otherOption = "other";

/** The options an Approval's buttons carry back. */
export const approveOption = "approve";
export const denyOption = "deny";

/**
 * One Bot Message as a messaging Channel's outbound Message (spec #1044, "How a Message shows on
 * Telegram"): its text, then its Rich control reduced the way email reduces it. A choice is a numbered
 * list with one button per option (a typed number answers too) and Other when offered, an Approval
 * has Approve and Deny, a Secret request is only a link into the app, and the Computer and
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
): Pick<OutboundMessage, "text" | "buttons" | "files"> {
  const paragraphs = [message.text];
  let buttons: MessagingButtons | undefined;
  let sent: OutboundMessage["files"];
  const control = message.control;
  const link = (lead: string) => (appUrl ? `[${lead}](${appUrl})` : lead);
  switch (control?.kind) {
    case "choice":
      if (control.answer) break;
      paragraphs.push(
        [...control.options, ...(control.other ? ["Other: reply with your own answer"] : [])]
          .map((item, index) => `${index + 1}. ${item}`)
          .join("\n"),
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
        paragraphs.push(left.map((name) => `- ${name}`).join("\n"), link("Download in the app"));
      }
      break;
    }
    case "secret":
      paragraphs.push(link("Enter it securely in the app"));
      break;
    case "computer":
      paragraphs.push(link("Take over the Computer in the app"));
      break;
    case "demonstration":
      paragraphs.push(link("Show me in the app"));
      break;
    case undefined:
      break;
    default:
      if (isApproval(control?.kind)) {
        buttons = {
          control: message.id,
          options: [
            { option: approveOption, label: "Approve" },
            { option: denyOption, label: "Deny" },
          ],
        };
        paragraphs.push("Reply yes or no, or answer in the app.");
      } else paragraphs.push(link("Open it in the app"));
  }
  return {
    text: paragraphs.filter((paragraph) => paragraph.trim() !== "").join("\n\n"),
    ...(buttons && { buttons }),
    ...(sent && { files: sent }),
  };
}
