/** Relative times and the Conversation list's date groups. */
export const timeMessages = {
  "time.justNow": "just now",
  "time.minutesAgo": ({ count }: { count: number }) => `${count}m ago`,
  "time.hoursAgo": ({ count }: { count: number }) => `${count}h ago`,
  "time.daysAgo": ({ count }: { count: number }) => `${count}d ago`,
  "time.today": "Today",
  "time.yesterday": "Yesterday",
  "time.previous7Days": "Previous 7 days",
  "time.previous30Days": "Previous 30 days",
};
