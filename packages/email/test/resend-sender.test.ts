import { describe, expect, it, vi } from "vitest";

import { renderTemplate } from "../src/templates";
import { createResendSender } from "../src/resend";

const FROM = "Acme Chat <no-reply@example.com>";
const URL = "https://chat.example.com/verify?token=abc";

function stubClient() {
  const send = vi.fn(async () => ({ data: { id: "email_1" }, error: null }));
  return { client: { emails: { send } }, send };
}

async function messageTo(to: string, subject?: string) {
  const message = await renderTemplate("verify-email", to, { appName: "Acme Chat", url: URL });
  return subject === undefined ? message : { ...message, subject };
}

describe("Resend sender", () => {
  it("hands the React content and plain text to the client", async () => {
    const { client, send } = stubClient();
    const sender = createResendSender({ apiKey: "re_test", from: FROM, client });
    const message = await messageTo("person@example.com");

    await sender.send(message);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      from: FROM,
      to: "person@example.com",
      subject: message.subject,
      react: message.react,
      text: message.text,
    });
  });

  it("refuses an invalid recipient without calling the client", async () => {
    const { client, send } = stubClient();
    const sender = createResendSender({ apiKey: "re_test", from: FROM, client });

    await expect(sender.send(await messageTo("not-an-address"))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an empty subject without calling the client", async () => {
    const { client, send } = stubClient();
    const sender = createResendSender({ apiKey: "re_test", from: FROM, client });

    await expect(sender.send(await messageTo("person@example.com", "  "))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a subject with a line break without calling the client", async () => {
    const { client, send } = stubClient();
    const sender = createResendSender({ apiKey: "re_test", from: FROM, client });

    await expect(
      sender.send(await messageTo("person@example.com", "Hi\r\nBcc: x@y.z")),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a from-address that is not an address", async () => {
    const { client, send } = stubClient();
    const sender = createResendSender({ apiKey: "re_test", from: "nobody at nowhere", client });

    await expect(sender.send(await messageTo("person@example.com"))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("throws when Resend reports an error", async () => {
    const send = vi.fn(async () => ({ data: null, error: { message: "domain not verified" } }));
    const sender = createResendSender({
      apiKey: "re_test",
      from: FROM,
      client: { emails: { send } },
    });

    await expect(sender.send(await messageTo("person@example.com"))).rejects.toThrow(
      "domain not verified",
    );
  });
});
