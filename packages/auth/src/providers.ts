// The Better Auth provider ids a user only links, never signs in with. Apart from `index.ts`, so the
// browser can read them without the auth server.

export const CHATGPT_PROVIDER = "chatgpt";

/** The GitHub Connection's provider id (ADR 0037): its own account row, next to the sign-in one. */
export const GITHUB_CONNECTION_PROVIDER = "github-connection";

/** The Google Calendar Connection's provider id (ADR 0037), on the Google sign-in's client. */
export const GOOGLE_CALENDAR_PROVIDER = "google-calendar";

/** The Gmail Connection's provider id (ADR 0037), on the Google sign-in's client. */
export const GMAIL_PROVIDER = "gmail";

/** The Notion Connection's provider id (ADR 0037), on its own Notion public integration. */
export const NOTION_PROVIDER = "notion";

/** Providers a user links on purpose but never signs in with: they don't count as a way to sign in. */
export const LINK_ONLY_PROVIDERS: readonly string[] = [
  CHATGPT_PROVIDER,
  GITHUB_CONNECTION_PROVIDER,
  GOOGLE_CALENDAR_PROVIDER,
  GMAIL_PROVIDER,
  NOTION_PROVIDER,
];
