import { describe, expect, it } from "vitest";

import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../core/server/credentials/encryption";

const keyA = "a-key-encryption-secret-of-at-least-32-chars";
const keyB = "another-secret-of-at-least-32-characters";
const context = "user-1:anthropic";
const credentials = { apiKey: "sk-ant-secret" };
const provider = { secrets: [keyA], kind: "provider" as const, context };

describe("credential encryption", () => {
  it("decrypts what it encrypted", () => {
    const encrypted = encryptCredentials(credentials, provider);

    expect(decryptCredentials(encrypted, provider)).toEqual({ ok: true, credentials });
  });

  it("never stores the plaintext, and writes the v2 format", () => {
    const encrypted = encryptCredentials(credentials, provider);

    expect(encrypted).not.toContain("sk-ant-secret");
    expect(encrypted.split(".")).toHaveLength(5);
    expect(encrypted.startsWith("v2.")).toBe(true);
  });

  it("encrypts the same credentials differently each time", () => {
    expect(encryptCredentials(credentials, provider)).not.toBe(
      encryptCredentials(credentials, provider),
    );
  });

  it("decrypts a secret written under an older key of the keyring", () => {
    const encrypted = encryptCredentials(credentials, provider);

    expect(decryptCredentials(encrypted, { ...provider, secrets: [keyB, keyA] })).toEqual({
      ok: true,
      credentials,
    });
  });

  it("writes under the first key of the keyring, named by its kid", () => {
    const kidOf = (secrets: string[]) =>
      encryptCredentials(credentials, { ...provider, secrets }).split(".")[1];

    expect(kidOf([keyB, keyA])).toBe(kidOf([keyB]));
    expect(kidOf([keyB, keyA])).not.toBe(kidOf([keyA]));
  });

  it("reads as unknown-key when no key of the keyring matches", () => {
    const encrypted = encryptCredentials(credentials, provider);

    expect(decryptCredentials(encrypted, { ...provider, secrets: [keyB] })).toEqual({
      ok: false,
      reason: "unknown-key",
    });
  });

  it("does not decrypt one kind of secret as the other", () => {
    const encrypted = encryptCredentials(credentials, provider);

    expect(decryptCredentials(encrypted, { ...provider, kind: "tool" })).toEqual({
      ok: false,
      reason: "unknown-key",
    });
  });

  it("reads a v1 value as corrupt, so as missing", () => {
    const v1 = "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA";

    expect(decryptCredentials(v1, provider)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reads as corrupt when the row was moved to another user or service", () => {
    const encrypted = encryptCredentials(credentials, provider);

    expect(decryptCredentials(encrypted, { ...provider, context: "user-2:anthropic" })).toEqual({
      ok: false,
      reason: "corrupt",
    });
  });

  it("reads as corrupt for a value that is not ours", () => {
    expect(decryptCredentials("garbage", provider)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("reads as corrupt when the auth tag was truncated", () => {
    const encrypted = encryptCredentials(credentials, provider);
    const [version, kid, iv, tag = "", ciphertext] = encrypted.split(".");
    const truncatedTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");

    expect(
      decryptCredentials([version, kid, iv, truncatedTag, ciphertext].join("."), provider),
    ).toEqual({ ok: false, reason: "corrupt" });
  });
});
