import { describe, expect, it } from "vitest";

import {
  quotaBlocksModel,
  quotaExceeded,
  quotaMeterFrom,
  quotaResetsAt,
} from "../../../core/client/quota";

const hostModel = { onHostCredentials: true };
const ownModel = { onHostCredentials: false };

describe("the Quota meter's threshold", () => {
  it("starts the meter at 80%", () => {
    expect(quotaMeterFrom).toBe(80);
  });
});

describe("whether the Quota is spent", () => {
  it("is spent only at 100%", () => {
    expect(quotaExceeded({ usedPercent: 99 })).toBe(false);
    expect(quotaExceeded({ usedPercent: 100 })).toBe(true);
  });

  it("is not spent while the Quota is unknown or unlimited", () => {
    expect(quotaExceeded(null)).toBe(false);
    expect(quotaExceeded(undefined)).toBe(false);
  });
});

describe("which Model the spent Quota blocks", () => {
  const spent = { usedPercent: 100 };

  it("blocks a Host Model once the Quota is spent", () => {
    expect(quotaBlocksModel(hostModel, spent)).toBe(true);
  });

  it("never blocks the user's own Model", () => {
    expect(quotaBlocksModel(ownModel, spent)).toBe(false);
  });

  it("blocks nothing while the Quota is not spent", () => {
    expect(quotaBlocksModel(hostModel, { usedPercent: 99 })).toBe(false);
    expect(quotaBlocksModel(hostModel, null)).toBe(false);
  });

  it("blocks nothing when the Model is not known yet", () => {
    expect(quotaBlocksModel(undefined, spent)).toBe(false);
  });
});

describe("the reset time shown to the user", () => {
  it("formats a Date and an ISO string the same way", () => {
    const at = new Date("2026-10-11T00:00:00.000Z");

    expect(quotaResetsAt(at)).toBe(quotaResetsAt(at.toISOString()));
    expect(quotaResetsAt(at)).toMatch(/\d/);
  });
});
