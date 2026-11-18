import type { LinkedAccessToken } from "@ai-chat/auth/linked-token";
import { describe, expect, it } from "vitest";

import { connectionHookOf, connectionsOf } from "./connections";

const hookFor = (token: LinkedAccessToken) => connectionHookOf({ github: async () => token });

describe("the Connections the Host declares", () => {
  it("declares GitHub when its client id and secret are set", () => {
    const [github, ...others] = connectionsOf({
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "s",
    });

    expect(others).toEqual([]);
    expect(github).toMatchObject({
      key: "github",
      name: "GitHub",
      mcp: { url: "https://api.githubcopilot.com/mcp/" },
    });
  });

  it.each([
    ["neither is set", {}],
    ["only the id is set", { GITHUB_CLIENT_ID: "id" }],
    ["only the secret is set", { GITHUB_CLIENT_SECRET: "s" }],
    ["both are empty", { GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }],
  ])("declares none when %s", (_name, env) => {
    expect(connectionsOf(env)).toEqual([]);
  });

  it("offers only an allowlist of GitHub's tools, and asks approval for every write", () => {
    const [github] = connectionsOf({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" });
    const allowed = github.mcp?.tools ?? [];

    expect(allowed).toEqual(
      expect.arrayContaining(["list_notifications", "issue_read", "pull_request_read"]),
    );
    expect(allowed).toEqual(
      expect.arrayContaining(["add_issue_comment", "issue_write", "pull_request_review_write"]),
    );
    // Nothing destructive or admin-like is offered, and no write skips approval.
    expect(allowed).not.toEqual(expect.arrayContaining(["merge_pull_request"]));
    expect(allowed).not.toEqual(expect.arrayContaining(["delete_repository"]));
    expect(github.approvalFree).toEqual(expect.arrayContaining(["list_notifications"]));
    for (const write of ["add_issue_comment", "issue_write", "create_issue"]) {
      expect(github.approvalFree).not.toContain(write);
    }
    // Approval-free tools are all in the allowlist.
    for (const tool of github.approvalFree ?? []) expect(allowed).toContain(tool);
  });
});

describe("the Google Calendar Connection", () => {
  const google = { GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "s" };

  it("is declared, with the Host's Calendar tools, when the Google client id and secret are set", () => {
    const [calendar, ...others] = connectionsOf(google);

    expect(others).toEqual([]);
    expect(calendar).toMatchObject({ key: "google_calendar", name: "Google Calendar" });
    expect(calendar.mcp).toBeUndefined();
    expect(calendar.tools?.map((tool) => tool.name)).toEqual([
      "list_calendars",
      "list_events",
      "create_event",
      "update_event",
      "respond_to_event",
    ]);
  });

  it("reads without approval or a write, and asks approval for every write", () => {
    const [calendar] = connectionsOf(google);

    expect(calendar.approvalFree).toEqual(["list_calendars", "list_events"]);
    expect(calendar.readOnlyTools).toEqual(["list_calendars", "list_events"]);
  });

  it.each([
    ["only the id is set", { GOOGLE_CLIENT_ID: "id" }],
    ["only the secret is set", { GOOGLE_CLIENT_SECRET: "s" }],
    ["both are empty", { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "" }],
  ])("is not declared when %s", (_name, env) => {
    expect(connectionsOf(env)).toEqual([]);
  });

  it("comes after GitHub when both clients are set", () => {
    const keys = connectionsOf({ ...google, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" });

    expect(keys.map((connection) => connection.key)).toEqual(["github", "google_calendar"]);
  });
});

describe("the connection hook", () => {
  it("answers the access token", async () => {
    const hook = hookFor({ status: "ok", accessToken: "gho_token" });

    expect(await hook("user-1", "github")).toEqual({ accessToken: "gho_token" });
  });

  it("answers reconnect when the token can't be refreshed", async () => {
    expect(await hookFor({ status: "needs-reconnect" })("user-1", "github")).toEqual({
      reconnect: true,
    });
  });

  it("answers nothing for a user who has not connected", async () => {
    expect(await hookFor({ status: "none" })("user-1", "github")).toBeNull();
  });

  it("answers nothing for a key the Host doesn't declare, without asking for a token", async () => {
    const hook = connectionHookOf({
      github: async () => {
        throw new Error("should not be asked");
      },
    });

    expect(await hook("user-1", "gmail")).toBeNull();
  });

  it("asks for the token of the user it was asked about", async () => {
    const asked: string[] = [];
    const hook = connectionHookOf({
      github: async (userId) => {
        asked.push(userId);
        return { status: "none" };
      },
    });

    await hook("user-7", "github");

    expect(asked).toEqual(["user-7"]);
  });
});
