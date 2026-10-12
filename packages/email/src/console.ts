import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { render } from "@react-email/components";

import { checkHeaders, type EmailMessage, type EmailSender } from "./sender";

// Development sender: prints the message's recipient, subject and link, and
// writes the rendered HTML to `outDir` so every flow can be clicked through
// without an email account.
export function createConsoleSender({
  from,
  outDir,
  logger = console,
}: {
  from: string;
  outDir: string;
  logger?: Pick<Console, "info">;
}): EmailSender {
  return {
    async send(message: EmailMessage) {
      checkHeaders(message, from);
      const html = await render(message.react);
      await mkdir(outDir, { recursive: true });
      const file = join(
        outDir,
        `${Date.now()}-${message.template}-${message.to.replace(/[^\w.@-]/g, "_")}.html`,
      );
      await writeFile(file, html, "utf8");
      logger.info(
        `[email] to=${message.to} subject="${message.subject}" link=${message.link ?? "(none)"} html=${file}`,
      );
    },
  };
}
