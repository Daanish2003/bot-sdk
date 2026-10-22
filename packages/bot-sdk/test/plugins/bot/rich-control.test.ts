import { describe, expect, it } from "vitest";
import { z } from "zod";

import { botMessagePartsSchema, richControlJsonSchema } from "../../../plugins/bot/client/index";

const secret = { kind: "secret", name: "GITHUB_TOKEN", why: "To push to your repository." };
const computer = { kind: "computer", helperId: "h1", reason: "Log in for me.", state: "open" };

describe("the Rich control catalog", () => {
  it("takes a Message of text plus one control, and rejects one with two", () => {
    const text = { type: "text", text: "I need a token to push." };
    const one = { schemaVersion: 1, parts: [text, { type: "control", control: secret }] };
    const two = {
      schemaVersion: 1,
      parts: [text, { type: "control", control: secret }, { type: "control", control: computer }],
    };

    expect(botMessagePartsSchema.safeParse(one).success).toBe(true);
    expect(botMessagePartsSchema.safeParse(two).success).toBe(false);
  });

  it("takes the Routine approval and the review approval, holding only the row id", () => {
    const published = z.fromJSONSchema(richControlJsonSchema);
    const routine = { kind: "routine_approval", routineId: "r1" };
    const review = { kind: "review_approval", reviewId: "v1" };

    expect(published.safeParse(routine).success).toBe(true);
    expect(published.safeParse(review).success).toBe(true);
    expect(published.safeParse({ kind: "routine_approval" }).success).toBe(false);
    expect(published.safeParse({ kind: "review_approval" }).success).toBe(false);
  });

  it("reserves draft and payment_approval, and refuses a kind it doesn't know", () => {
    const published = z.fromJSONSchema(richControlJsonSchema);

    expect(published.safeParse({ kind: "draft" }).success).toBe(true);
    expect(published.safeParse({ kind: "payment_approval", amount: 12 }).success).toBe(true);
    expect(published.safeParse({ kind: "poll" }).success).toBe(false);
  });
});
