import { createDb } from "@ai-chat/db";
import { twoFactor, user } from "@ai-chat/db/schema/auth";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { turnOffTwoFactorRows } from "../src/two-factor-off";

const database = createDb({ DATABASE_URL: process.env.TEST_DATABASE_URL ?? "" });

afterAll(async () => {
  await database.$client.end();
});

/** A user with two-factor sign-in on (or off), and a TOTP row. */
async function seedUser(twoFactorEnabled: boolean) {
  const id = randomUUID();
  const email = `two-factor-off-${randomUUID()}@example.com`;
  const now = new Date();
  await database.insert(user).values({
    id,
    name: "Lost Phone",
    email,
    emailVerified: true,
    twoFactorEnabled,
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(twoFactor).values({
    id: randomUUID(),
    userId: id,
    secret: "encrypted-secret",
    backupCodes: "encrypted-codes",
    verified: true,
  });
  return { id, email };
}

async function flagOf(id: string) {
  const [row] = await database
    .select({ enabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.id, id));
  return row?.enabled;
}

async function rowsOf(id: string) {
  return (await database.select().from(twoFactor).where(eq(twoFactor.userId, id))).length;
}

describe("turning off a user's two-factor rows", () => {
  it("deletes the TOTP row, clears the flag and returns the user's email", async () => {
    const person = await seedUser(true);
    const other = await seedUser(true);

    expect(await turnOffTwoFactorRows(database, person.id)).toEqual({ email: person.email });

    expect(await flagOf(person.id)).toBe(false);
    expect(await rowsOf(person.id)).toBe(0);
    // Another user's two-factor sign-in is untouched.
    expect(await flagOf(other.id)).toBe(true);
    expect(await rowsOf(other.id)).toBe(1);
  });

  it("changes nothing for a user without two-factor sign-in on", async () => {
    const person = await seedUser(false);

    expect(await turnOffTwoFactorRows(database, person.id)).toBeNull();

    expect(await flagOf(person.id)).toBe(false);
    expect(await rowsOf(person.id)).toBe(1);
  });

  it("returns null for a user that doesn't exist", async () => {
    expect(await turnOffTwoFactorRows(database, randomUUID())).toBeNull();
  });
});
