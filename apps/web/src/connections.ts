import {
  GITHUB_CONNECTION_PROVIDER,
  GMAIL_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
} from "@ai-chat/auth";
import type { LinkedAccessToken } from "@ai-chat/auth/linked-token";
import type { ConnectionHook, McpConnection } from "@botsdk/mcp";

import { gmailTools } from "./gmail";
import { googleCalendarTools } from "./google-calendar";

// GitHub's remote MCP server tools (github/github-mcp-server, its `readOnlyHint: true` tools of the
// notifications, issues, pull_requests and repos toolsets). A read needs no approval.
const githubReadTools = [
  "list_notifications",
  "get_notification_details",
  "issue_read",
  "list_issues",
  "search_issues",
  "list_issue_types",
  "list_issue_fields",
  "get_label",
  "pull_request_read",
  "list_pull_requests",
  "search_pull_requests",
  "get_file_contents",
  "get_commit",
  "list_commits",
  "list_branches",
  "list_tags",
  "get_tag",
  "list_releases",
  "get_latest_release",
  "get_release_by_tag",
  "search_code",
  "search_repositories",
];

// The writes: a comment, an issue and a pull request review. The server serves an issue's create
// and update as `issue_write` and a review's as `pull_request_review_write`; the granular
// `create_issue` and `create_pull_request_review` come behind a feature flag, and the allowlist
// skips a name the server doesn't list. Each asks for approval.
const githubWriteTools = [
  "add_issue_comment",
  "issue_write",
  "create_issue",
  "pull_request_review_write",
  "create_pull_request_review",
];

// The Google Calendar tools that only read: no approval, and a read-only run may call them.
const calendarReadTools = ["list_calendars", "list_events"];

// The Gmail tools that only read: no approval, and a read-only run may call them.
const gmailReadTools = ["search_threads", "get_thread"];

/**
 * The Connections the Host declares (ADR 0037), each when the sign-in client it reuses is set:
 * GitHub on the GitHub OAuth App, Google Calendar and Gmail on the Google client.
 */
export function connectionsOf(env: {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}): McpConnection[] {
  return [
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? [
          {
            key: "github",
            name: "GitHub",
            mcp: {
              url: "https://api.githubcopilot.com/mcp/",
              tools: [...githubReadTools, ...githubWriteTools],
            },
            approvalFree: githubReadTools,
          },
        ]
      : []),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? [
          {
            key: "google_calendar",
            name: "Google Calendar",
            tools: googleCalendarTools(),
            approvalFree: calendarReadTools,
            readOnlyTools: calendarReadTools,
          },
          {
            key: "gmail",
            name: "Gmail",
            tools: gmailTools(),
            approvalFree: gmailReadTools,
            readOnlyTools: gmailReadTools,
          },
        ]
      : []),
  ];
}

/**
 * The `mcp` feature's `connection` hook: a Connection's access token, `{ reconnect: true }` when
 * its token can't be refreshed, nothing when it is not linked. `tokenFor` is each Connection's,
 * by key, and reads Better Auth through apps/web's own database pool, never the SDK's connection.
 */
export function connectionHookOf(
  tokenFor: Record<string, (userId: string) => Promise<LinkedAccessToken>>,
): ConnectionHook {
  return async (userId, key) => {
    const token = await tokenFor[key]?.(userId);
    if (token?.status === "ok") return { accessToken: token.accessToken };
    return token?.status === "needs-reconnect" ? { reconnect: true } : null;
  };
}

/**
 * Each Connection's token, by key, from its Better Auth provider through `read`. Read afresh on
 * every ask, never cached: Settings lists the states again right after a Disconnect, and the
 * Connection's tools must stop with it.
 */
export function connectionTokensOf(
  read: (userId: string, providerId: string) => Promise<LinkedAccessToken>,
): Record<string, (userId: string) => Promise<LinkedAccessToken>> {
  return {
    github: (userId) => read(userId, GITHUB_CONNECTION_PROVIDER),
    google_calendar: (userId) => read(userId, GOOGLE_CALENDAR_PROVIDER),
    gmail: (userId) => read(userId, GMAIL_PROVIDER),
  };
}
