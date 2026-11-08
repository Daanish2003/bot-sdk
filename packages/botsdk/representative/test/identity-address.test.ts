import { describe, expect, it } from "vitest";

import {
  customerAddIdentityInput,
  customerCreateInput,
  customerUpdateIdentityInput,
  identityAddress,
} from "../src/shared/contract";

/*
 * An address as identities hold it (#1174 review): an SMS number in E.164, as Telnyx gives the
 * sender's, however the owner or the Model typed it, so one number is one identity.
 */

const id = "0190f6a4-0000-7000-8000-000000000001";

describe("an SMS identity's address", () => {
  it("is the number in E.164, without its spaces, dashes, dots or brackets", () => {
    expect(identityAddress("sms", "+1 (555) 123-4567")).toBe("+15551234567");
    expect(identityAddress("sms", " +44 20.7946.0958 ")).toBe("+442079460958");
    expect(identityAddress("sms", "+15551234567")).toBe("+15551234567");
  });

  it("takes an international 00 prefix as +", () => {
    expect(identityAddress("sms", "0044 20 7946 0958")).toBe("+442079460958");
  });

  it("is the same on every RPC an owner gives a number to", () => {
    const typed = { channel: "SMS", externalId: "+1 (555) 123-4567" };
    expect(customerCreateInput.parse(typed).externalId).toBe("+15551234567");
    expect(customerAddIdentityInput.parse({ id, ...typed }).externalId).toBe("+15551234567");
    expect(customerUpdateIdentityInput.parse({ id, identityId: id, ...typed }).externalId).toBe(
      "+15551234567",
    );
  });

  it("leaves other Channels' addresses alone but for an email's case", () => {
    expect(identityAddress("telegram", "+1 (555) 123")).toBe("+1 (555) 123");
    expect(identityAddress("email", "Ada@Example.com")).toBe("ada@example.com");
  });
});
