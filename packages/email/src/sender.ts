import type { ReactElement } from "react";

import type { TemplateName } from "./templates";

export type EmailMessage = {
  to: string;
  subject: string;
  template: TemplateName;
  react: ReactElement;
  text: string;
  link?: string;
};

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// "Name <address>" or a bare address.
function addressOf(from: string): string {
  const match = /<([^<>]+)>\s*$/.exec(from);
  return (match?.[1] ?? from).trim();
}

// Shared by every sender, so a sender that talks to a real provider and the
// capture mailbox refuse the same messages.
export function checkHeaders(message: EmailMessage, from: string): void {
  if (!ADDRESS.test(message.to)) {
    throw new Error(`Refusing to send: invalid recipient "${message.to}"`);
  }
  if (!ADDRESS.test(addressOf(from))) {
    throw new Error(`Refusing to send: invalid from-address "${from}"`);
  }
  if (message.subject.trim() === "" || /[\r\n]/.test(message.subject)) {
    throw new Error("Refusing to send: subject must be one non-empty line");
  }
}
