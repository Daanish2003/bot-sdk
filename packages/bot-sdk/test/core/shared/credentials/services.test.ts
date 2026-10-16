import { describe, expect, it } from "vitest";

import {
  addKeyMessage,
  type CredentialService,
  credentialFieldSchemas,
  credentialForms,
  credentialHint,
  isCredentialService,
  providers,
} from "../../../../core/shared/credentials/services";

describe("addKeyMessage", () => {
  it("asks for the Provider's key, with the right article", () => {
    expect(addKeyMessage("openai")).toBe("Add an OpenAI key or pick another Model");
    expect(addKeyMessage("gemini")).toBe("Add a Google Gemini key or pick another Model");
  });
});

describe("credentialFieldSchemas", () => {
  it("asks Cloudflare for an account id and an API token", () => {
    expect(
      credentialFieldSchemas.cloudflare.safeParse({ accountId: " acc123 ", apiKey: "tok" }),
    ).toEqual({ success: true, data: { accountId: "acc123", apiKey: "tok" } });
    expect(credentialFieldSchemas.cloudflare.safeParse({ apiKey: "tok" }).success).toBe(false);
  });

  it("asks Bedrock for an API key and an AWS region", () => {
    expect(
      credentialFieldSchemas.bedrock.safeParse({ apiKey: "key", region: "us-east-1" }).success,
    ).toBe(true);
    expect(
      credentialFieldSchemas.bedrock.safeParse({ apiKey: "key", region: "Virginia" }).success,
    ).toBe(false);
  });

  it("asks Ollama only for a host URL, without a trailing slash", () => {
    expect(credentialFieldSchemas.ollama.parse({ host: " http://localhost:11434/ " })).toEqual({
      host: "http://localhost:11434",
    });
    expect(credentialFieldSchemas.ollama.safeParse({ host: "localhost" }).success).toBe(false);
  });

  it("covers every Provider, with a form and help text for each", () => {
    for (const { id } of providers) {
      expect(isCredentialService(id), id).toBe(true);
      expect(credentialForms[id as CredentialService].helpText, id).not.toBe("");
    }
  });

  it("mentions Gemini's free-tier data use and Ollama under Docker", () => {
    expect(credentialForms.gemini.helpText).toMatch(/free tier/i);
    expect(credentialForms.ollama.helpText).toContain("host.docker.internal");
  });
});

describe("credentialHint", () => {
  it("shows the end of the API key", () => {
    expect(credentialHint({ accountId: "acc123", apiKey: "cf-token-wxyz" })).toBe("…wxyz");
  });

  it("shows the Ollama host, which isn't a secret", () => {
    expect(credentialHint({ host: "http://localhost:11434" })).toBe("http://localhost:11434");
  });
});
