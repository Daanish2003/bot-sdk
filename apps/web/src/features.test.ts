import { createBotSdk } from "@ai-chat/bot-sdk/core/server";
import type { ComputerProvider } from "@ai-chat/bot-sdk/plugins/computer/server";
import { mcp } from "@ai-chat/bot-sdk/plugins/mcp/server";
import { describe, expect, it } from "vitest";

import { computerFeatures } from "./features";

// Builds the SDK the way services.ts does, with no database call until a route runs.
const sdkWith = (computer: ComputerProvider | undefined) =>
  createBotSdk({
    databaseUrl: "postgresql://postgres:password@127.0.0.1:1/unused",
    keyEncryptionSecrets: ["test-key-encryption-secret"],
    getUser: () => null,
    basePath: "/api/chat",
    models: {},
    channels: [],
    computer,
    features: [...computerFeatures(computer), mcp({ servers: [] })],
  });

// Spec #871 user story 8: a Host with no Computer still starts, without the features that need one.
describe("computerFeatures", () => {
  it("lists no Memory, Skills or Knowledge without a Computer, so the SDK builds", () => {
    const sdk = sdkWith(undefined);
    expect("memory" in sdk).toBe(false);
    expect("skills" in sdk).toBe(false);
    expect("knowledge" in sdk).toBe(false);
    expect("mcp" in sdk).toBe(true);
    expect(computerFeatures(undefined)).toEqual([]);
  });

  it("lists Memory, Skills and Knowledge, in that order, with a Computer", () => {
    const computer = { kind: "stub" } as unknown as ComputerProvider;
    expect(computerFeatures(computer).map((entry) => entry.id)).toEqual([
      "memory",
      "skills",
      "knowledge",
    ]);
    const sdk = sdkWith(computer);
    expect("memory" in sdk).toBe(true);
    expect("skills" in sdk).toBe(true);
    expect("knowledge" in sdk).toBe(true);
  });
});
