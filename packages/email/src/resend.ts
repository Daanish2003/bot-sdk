import { Resend } from "resend";
import type { ReactElement } from "react";

import { checkHeaders, type EmailMessage, type EmailSender } from "./sender";

// The part of the Resend client this sender uses, so tests can stub it.
export type ResendEmails = {
  send(payload: {
    from: string;
    to: string;
    subject: string;
    react: ReactElement;
    text: string;
  }): Promise<{ error: { message: string } | null }>;
};

export function createResendSender({
  apiKey,
  from,
  client = { emails: new Resend(apiKey).emails },
}: {
  apiKey: string;
  from: string;
  client?: { emails: ResendEmails };
}): EmailSender {
  return {
    async send(message: EmailMessage) {
      checkHeaders(message, from);
      const { error } = await client.emails.send({
        from,
        to: message.to,
        subject: message.subject,
        react: message.react,
        text: message.text,
      });
      if (error) {
        throw new Error(`Resend refused the message: ${error.message}`);
      }
    },
  };
}
