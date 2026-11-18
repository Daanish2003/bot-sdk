import type { LinkedAccessToken } from "@ai-chat/auth/linked-token";
import { describe, expect, it } from "vitest";

import { connectionHookOf, connectionsOf, unlinkConnection } from "./connections";

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
    const allowed = github.mcp.tools ?? [];

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

describe("disconnecting a Connection", () => {
  it("unlinks only the Connection's own rows, not the GitHub sign-in's", async () => {
    const unlinked: string[] = [];

    await unlinkConnection(
      [
        { id: "a1", providerId: "github" },
        { id: "a2", providerId: "github-connection" },
        { id: "a3", providerId: "google" },
      ],
      "github",
      async (id) => {
        unlinked.push(id);
      },
    );

    expect(unlinked).toEqual(["a2"]);
  });

  it("does nothing for a key the Host doesn't declare", async () => {
    await unlinkConnection([{ id: "a1", providerId: "github-connection" }], "gmail", async () => {
      throw new Error("should not unlink");
    });
  });
});
