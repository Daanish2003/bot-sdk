import { describe, expect, it } from "vitest";

import { scoreDraft } from "../../../eval/skills/draft-score";
import { draftExpectations, fakeDraft, loadFixture } from "../../../eval/skills/fixtures";

const ids = Object.keys(draftExpectations);

describe("the drafting eval's fixtures", () => {
  it("has three Demonstrations, each with events and a PNG per screenshot", async () => {
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const fixture = await loadFixture(id);
      expect(fixture.events.length).toBeGreaterThan(3);
      for (const event of fixture.events) {
        if (!event.screenshot) continue;
        const bytes = fixture.screenshots.get(event.screenshot)!;
        expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      }
    }
  });

  it("keeps a password masked, with no screenshot, and its plaintext out of the files", async () => {
    const fixture = await loadFixture("download-invoice");
    const password = fixture.events.find((event) => event.label === "Password")!;
    expect(password).toMatchObject({ value: "••••••••", screenshot: null });
    expect(JSON.stringify(fixture)).not.toContain("hunter2");
  });
});

describe("scoring a drafted Skill", () => {
  it("passes the Skill a good model drafts for each fixture", async () => {
    for (const id of ids) {
      const fixture = await loadFixture(id);
      const score = scoreDraft(
        fakeDraft(fixture, draftExpectations[id]!),
        fixture.goal,
        draftExpectations[id]!,
      );
      expect(score.reasons, id).toEqual([]);
    }
  });

  it("fails a reply that is not a usable Skill", () => {
    const score = scoreDraft(
      "Sure, here you go!",
      "Copy payouts",
      draftExpectations["payouts-to-sheet"]!,
    );
    expect(score.passed).toBe(false);
    expect(score.reasons[0]).toContain("isn't a usable Skill");
  });

  it("fails a description that does not start 'Use this when'", async () => {
    const fixture = await loadFixture("payouts-to-sheet");
    const reply = fakeDraft(fixture, draftExpectations["payouts-to-sheet"]!).replace(
      "Use this when",
      "For when",
    );
    expect(scoreDraft(reply, fixture.goal, draftExpectations["payouts-to-sheet"]!).passed).toBe(
      false,
    );
  });

  it("fails a Skill that misses an input, a URL or a label", async () => {
    const fixture = await loadFixture("payouts-to-sheet");
    const expected = draftExpectations["payouts-to-sheet"]!;
    const reply = fakeDraft(fixture, expected)
      .replace("- the week", "- nothing")
      .replace("sheets.example.com/sheet", "elsewhere.example")
      .replace('"Save sheet"', '"Submit"');
    expect(scoreDraft(reply, fixture.goal, expected).reasons).toEqual([
      "the Inputs never name /week/i",
      "the Skill never names the page sheets.example.com/sheet",
      'the Skill never names "Save sheet"',
    ]);
  });

  it("fails a Skill that writes the mask or a typed password", async () => {
    const fixture = await loadFixture("download-invoice");
    const expected = draftExpectations["download-invoice"]!;
    const reply = `${fakeDraft(fixture, expected)}\nPassword: ••••••••, usually hunter2-not-a-real-password`;
    expect(scoreDraft(reply, fixture.goal, expected).reasons).toEqual([
      'the Skill leaks "••••••••"',
      'the Skill leaks "hunter2-not-a-real-password"',
    ]);
  });
});
