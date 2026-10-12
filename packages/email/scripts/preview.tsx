import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { render } from "@react-email/components";

import { renderTemplate, TEMPLATE_NAMES, type TemplateName } from "../src/templates";

// Renders every template to .email-preview/<name>.html and .txt, so each
// one can be opened in a browser while it is being changed.
const outDir = join(import.meta.dirname, "..", ".email-preview");
const appName = process.env.APP_NAME ?? "Acme Chat";
const url = "https://chat.example.com/verify?token=preview";

await mkdir(outDir, { recursive: true });
for (const name of TEMPLATE_NAMES) {
  const props =
    name === "password-changed" || name === "account-deleted" ? { appName } : { appName, url };
  const message = await renderTemplate(name as TemplateName, "preview@example.com", props as never);
  await writeFile(join(outDir, `${name}.html`), await render(message.react), "utf8");
  await writeFile(join(outDir, `${name}.txt`), message.text, "utf8");
}
console.log(`Rendered ${TEMPLATE_NAMES.length} templates to ${outDir}`);
