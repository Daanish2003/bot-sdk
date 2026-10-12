import { render } from "@react-email/components";
import { describe, expect, it } from "vitest";

import { renderTemplate, TEMPLATE_NAMES, type TemplateName } from "../src/templates";

const APP = "Acme Chat";
const LINK = "https://chat.example.com/api/auth/verify-email?token=abc123";
const LINK_TEMPLATES: TemplateName[] = [
  "verify-email",
  "reset-password",
  "change-email-confirm",
  "verify-new-email",
  "delete-account-confirm",
];
const NOTICE_TEMPLATES = TEMPLATE_NAMES.filter((name) => !LINK_TEMPLATES.includes(name));

describe("email templates", () => {
  it("has the seven templates from the ticket", () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(
      [
        "account-deleted",
        "change-email-confirm",
        "delete-account-confirm",
        "password-changed",
        "reset-password",
        "verify-email",
        "verify-new-email",
      ].sort(),
    );
  });

  it.each(LINK_TEMPLATES)(
    "%s renders its link, expiry note and footer in HTML and text",
    async (name) => {
      const message = await renderTemplate(name, "person@example.com", { appName: APP, url: LINK });
      const html = await render(message.react);
      const text = await render(message.react, { plainText: true });

      expect(message.template).toBe(name);
      expect(message.to).toBe("person@example.com");
      expect(message.link).toBe(LINK);
      expect(html).toContain(LINK);
      expect(text).toContain(LINK);
      expect(html).toMatch(/expires/i);
      expect(text).toMatch(/expires/i);
      expect(html).toContain(APP);
      expect(html).toContain("You received this email");
      expect(text).toContain("You received this email");
    },
  );

  it.each(NOTICE_TEMPLATES)(
    "%s renders HTML and text with the footer and no link",
    async (name) => {
      const message = await renderTemplate(name, "person@example.com", { appName: APP });
      const html = await render(message.react);
      const text = await render(message.react, { plainText: true });

      expect(message.link).toBeUndefined();
      expect(message.subject).toContain(APP);
      expect(html).toContain(APP);
      expect(html).toContain("You received this email");
      expect(text).toContain("You received this email");
    },
  );
});
