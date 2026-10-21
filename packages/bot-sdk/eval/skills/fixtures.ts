// The drafting-pass eval's fixture Demonstrations (spec #713, ticket #721): the events and screenshots
// under eval/skills/fixtures/<id>/, recorded by record-fixtures.ts against a local Chromium (not the
// real Computer), and what a good Skill drafted from each must contain.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { maskedValue } from "../../plugins/bot/server/demonstration-capture";
import type { DraftExpect } from "./draft-score";

const directory = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** A fixture as record-fixtures.ts writes it, in events.json. */
export type RecordedFixture = {
  goal: string;
  inputs: string[];
  events: {
    sequence: number;
    offsetMs: number;
    kind: string;
    url: string | null;
    label: string | null;
    selector: string | null;
    value: string | null;
    /** The PNG beside events.json, or null when none was taken (a password field). */
    screenshot: string | null;
  }[];
};

/** The ids of the fixtures, and what each one's Skill must contain. */
export const draftExpectations: Record<string, DraftExpect> = {
  "payouts-to-sheet": {
    inputs: [/week/i],
    urls: ["dashboard.example.com/payouts", "sheets.example.com/sheet"],
    labels: ["Export CSV", "Paste payouts", "Save sheet"],
    secrets: [maskedValue],
  },
  "download-invoice": {
    inputs: [/month/i],
    urls: ["billing.acme-vendor.example/login", "billing.acme-vendor.example/invoices"],
    labels: ["Email", "Password", "Sign in", "Download invoice"],
    secrets: [maskedValue, "hunter2-not-a-real-password"],
  },
  "book-meeting-room": {
    inputs: [/room/i, /date/i, /attendees|people|who/i],
    urls: ["rooms.example.com/rooms"],
    labels: ["Room", "Date", "Attendees", "Book room"],
    secrets: [maskedValue],
  },
};

export type Fixture = RecordedFixture & {
  id: string;
  /** Each screenshot's PNG bytes, by file name. */
  screenshots: Map<string, Uint8Array>;
};

/** Reads fixture `id`: its events and screenshots. */
export async function loadFixture(id: string): Promise<Fixture> {
  const root = join(directory, id);
  const recorded = JSON.parse(await readFile(join(root, "events.json"), "utf8")) as RecordedFixture;
  const screenshots = new Map<string, Uint8Array>();
  for (const event of recorded.events) {
    if (event.screenshot) {
      screenshots.set(
        event.screenshot,
        new Uint8Array(await readFile(join(root, event.screenshot))),
      );
    }
  }
  return { ...recorded, id, screenshots };
}

/** A SKILL.md a good model would draft for a fixture: what the dry run plays. */
export function fakeDraft(fixture: RecordedFixture, expected: DraftExpect): string {
  return [
    "---",
    `name: ${fixture.goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)}`,
    `description: Use this when the user wants to: ${fixture.goal}`,
    "---",
    "## Inputs",
    ...fixture.inputs.map((input) => `- ${input}`),
    "## Steps",
    ...expected.urls.map((url, index) => `${index + 1}. Open https://${url}.`),
    `${expected.urls.length + 1}. Use ${expected.labels.map((label) => `"${label}"`).join(", ")}.`,
    "## How to check",
    "The last page confirms the task.",
  ].join("\n");
}
