import type { LinkedAccessToken } from "@ai-chat/auth/linked-token";
import type { ConnectionHook, McpConnection } from "@botsdk/mcp";

// The Better Auth provider behind each Connection, by the Connection's key (ADR 0037). It is
// `GITHUB_CONNECTION_PROVIDER` of @ai-chat/auth, written out here because the Keys page imports this
// file and must not pull the auth server into the browser.
export const connectionProviders: Record<string, string> = {
  github: "github-connection",
};

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

/**
 * The Connections the Host declares (ADR 0037): GitHub when the GitHub sign-in's client is set,
 * since the Connection reuses that OAuth App.
 */
export function connectionsOf(env: {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}): McpConnection[] {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return [];
  return [
    {
      key: "github",
      name: "GitHub",
      mcp: {
        url: "https://api.githubcopilot.com/mcp/",
        tools: [...githubReadTools, ...githubWriteTools],
      },
      approvalFree: githubReadTools,
    },
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

/** Unlinks every account row of a Connection, one after another, and no other account. */
export async function unlinkConnection(
  accounts: { id: string; providerId: string }[],
  key: string,
  unlink: (accountId: string) => Promise<void>,
): Promise<void> {
  const providerId = connectionProviders[key];
  if (!providerId) return;
  for (const linked of accounts.filter((account) => account.providerId === providerId)) {
    await unlink(linked.id);
  }
}
