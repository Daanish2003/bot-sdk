import { describe, expect, it } from "vitest";

import { chatgptLinkEnabled, linkedCredentialsHook } from "./chatgpt-link";

describe("whether Connect ChatGPT is on", () => {
  it("is on only when both the client id and the host id are set", () => {
    expect(chatgptLinkEnabled({ CHATGPT_CLIENT_ID: "id", CHATGPT_HOST_ID: "host" })).toBe(true);
    expect(chatgptLinkEnabled({ CHATGPT_CLIENT_ID: "id" })).toBe(false);
    expect(chatgptLinkEnabled({ CHATGPT_HOST_ID: "host" })).toBe(false);
    expect(chatgptLinkEnabled({})).toBe(false);
  });

  it("gives the models plugin a hook only when it is on, so plan Models resolve as before without it", () => {
    const hook = async () => null;

    expect(linkedCredentialsHook({ CHATGPT_CLIENT_ID: "id" }, hook)).toEqual({});
    expect(
      linkedCredentialsHook({ CHATGPT_CLIENT_ID: "id", CHATGPT_HOST_ID: "host" }, hook),
    ).toEqual({ linkedCredentials: hook });
  });
});
