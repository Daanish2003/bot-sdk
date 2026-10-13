import { describe, expect, it } from "vitest";

import { installRowState } from "./install-prompt";

const base = { installed: false, dismissed: false, ios: false, promptAvailable: false };

describe("the install row's state", () => {
  it("offers Install on Chromium once the browser offers the prompt", () => {
    expect(installRowState({ ...base, promptAvailable: true })).toBe("install");
  });

  it("shows the Share steps on iOS Safari, which has no prompt", () => {
    expect(installRowState({ ...base, ios: true })).toBe("ios");
  });

  it("shows nothing when the app is already installed", () => {
    expect(installRowState({ ...base, installed: true, promptAvailable: true })).toBe("hidden");
    expect(installRowState({ ...base, installed: true, ios: true })).toBe("hidden");
  });

  it("shows nothing once dismissed, even when the prompt is offered", () => {
    expect(installRowState({ ...base, dismissed: true, promptAvailable: true })).toBe("hidden");
    expect(installRowState({ ...base, dismissed: true, ios: true })).toBe("hidden");
  });

  it("shows nothing on a browser with no install path", () => {
    expect(installRowState(base)).toBe("hidden");
  });
});
