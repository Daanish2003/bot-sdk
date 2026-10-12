import type { EmailMessage, EmailSender } from "./sender";

// Test sender: keeps every message so a test can read the link back.
export type MemorySender = EmailSender & {
  readonly messages: EmailMessage[];
  lastLinkTo(address: string): string | undefined;
};

export function createMemorySender(): MemorySender {
  const messages: EmailMessage[] = [];
  return {
    messages,
    async send(message) {
      messages.push(message);
    },
    lastLinkTo(address) {
      const last = [...messages].reverse().find((message) => message.to === address);
      return last?.link;
    },
  };
}
