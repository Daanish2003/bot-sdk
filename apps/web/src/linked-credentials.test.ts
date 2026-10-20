import type { ChatgptAccessToken } from "@ai-chat/auth/chatgpt";
import { describe, expect, it } from "vitest";

import { linkedCredentialsOf } from "./linked-credentials";

const hookFor = (token: ChatgptAccessToken) => linkedCredentialsOf(async () => token);

describe("the linkedCredentials hook", () => {
  it("answers a ChatGPT access token as OpenAI's apiKey", async () => {
    const hook = hookFor({ status: "ok", accessToken: "plan-token" });

    expect(await hook("user-1", "openai")).toEqual({ apiKey: "plan-token" });
  });

  it("answers nothing for a user who has not linked ChatGPT", async () => {
    expect(await hookFor({ status: "none" })("user-1", "openai")).toBeNull();
  });

  it("answers needs-reconnect when the token can't be refreshed", async () => {
    expect(await hookFor({ status: "needs-reconnect" })("user-1", "openai")).toBe(
      "needs-reconnect",
    );
  });

  it("answers nothing for a service other than OpenAI, without asking for a token", async () => {
    const hook = linkedCredentialsOf(async () => {
      throw new Error("should not be asked");
    });

    expect(await hook("user-1", "anthropic")).toBeNull();
  });

  it("asks for the token of the user it was asked about", async () => {
    const asked: string[] = [];
    const hook = linkedCredentialsOf(async (userId) => {
      asked.push(userId);
      return { status: "none" };
    });

    await hook("user-7", "openai");

    expect(asked).toEqual(["user-7"]);
  });
});
