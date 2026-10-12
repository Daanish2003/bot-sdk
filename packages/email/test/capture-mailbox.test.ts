import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createCaptureMailbox, createMemoryCaptureStore } from "../src/capture";
import { renderTemplate } from "../src/templates";

const FROM = "Acme Chat <no-reply@example.com>";
const APP = "Acme Chat";
const TEN_MINUTES = 10 * 60 * 1000;

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function messageTo(to: string, url = "https://chat.example.com/verify?token=abc") {
  return renderTemplate("verify-email", to, { appName: APP, url });
}

describe("capture mailbox", () => {
  it("keys messages by a hash of the lowercased address, never the raw address", async () => {
    const store = createMemoryCaptureStore();
    const mailbox = createCaptureMailbox({ from: FROM, store });
    await mailbox.sender.send(await messageTo("Person@Example.com"));

    const expected = createHash("sha256").update("person@example.com").digest("hex");
    expect(await mailbox.read("person@example.com")).toHaveLength(1);
    expect(await mailbox.read("PERSON@example.com")).toHaveLength(1);
    expect(store.keys()).toEqual([expected]);
    expect(store.keys().join("")).not.toContain("person");
  });

  it("returns the messages for an address oldest first, with template, subject and text", async () => {
    const mailbox = createCaptureMailbox({ from: FROM });
    const first = await messageTo("person@example.com", "https://chat.example.com/verify?token=1");
    const second = await messageTo("person@example.com", "https://chat.example.com/verify?token=2");
    await mailbox.sender.send(first);
    await mailbox.sender.send(second);
    await mailbox.sender.send(await messageTo("other@example.com"));

    const messages = await mailbox.read("person@example.com");
    expect(messages.map((message) => message.subject)).toEqual([first.subject, second.subject]);
    expect(messages[0]).toMatchObject({ template: "verify-email", subject: first.subject });
    expect(messages[0]?.text).toContain("token=1");
    expect(messages[1]?.text).toContain("token=2");
  });

  it("drops messages ten minutes after they were sent", async () => {
    const time = clock();
    const store = createMemoryCaptureStore(time.now);
    const mailbox = createCaptureMailbox({ from: FROM, store, now: time.now });
    await mailbox.sender.send(await messageTo("person@example.com"));

    time.advance(TEN_MINUTES - 1);
    expect(await mailbox.read("person@example.com")).toHaveLength(1);

    time.advance(1);
    expect(await mailbox.read("person@example.com")).toHaveLength(0);
    expect(store.keys()).toEqual([]);
  });

  it("refuses what the header checks refuse", async () => {
    const store = createMemoryCaptureStore();
    const mailbox = createCaptureMailbox({ from: FROM, store });
    const message = await messageTo("not-an-address");

    await expect(mailbox.sender.send(message)).rejects.toThrow(/invalid recipient/);
    await expect(
      mailbox.sender.send({ ...(await messageTo("person@example.com")), subject: "bad\nsubject" }),
    ).rejects.toThrow(/one non-empty line/);
    expect(store.keys()).toEqual([]);
  });

  it("a message captured through one mailbox is readable through another on the same store", async () => {
    const store = createMemoryCaptureStore();
    const sending = createCaptureMailbox({ from: FROM, store });
    const reading = createCaptureMailbox({ from: FROM, store });
    await sending.sender.send(await messageTo("shared@example.com"));

    const messages = await reading.read("shared@example.com");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ template: "verify-email" });
  });
});
