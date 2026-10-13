import type { PastChatsView } from "../../core/shared/chat/past-chats";
import { relativeTime } from "../../core/client/relative-time";
import { SearchIcon } from "lucide-react";

import { useChatAdapter, useI18n } from "../../core/client/react/provider";

/**
 * A `search_past_chats` call (spec #263): one line of what was searched, then links to the
 * Conversations it found. A Shared link has no query or Conversations, only the line.
 */
export function PastChatsRow({ search }: { search: PastChatsView }) {
  const { Link } = useChatAdapter();
  const i18n = useI18n();
  const { t } = i18n;
  const query = search.query;
  const text =
    query === undefined
      ? t("chat.pastChatsSearchedShared")
      : search.state === "error"
        ? t("chat.pastChatsFailed")
        : search.state === "running"
          ? t("chat.pastChatsSearching", { query })
          : search.conversations.length === 0
            ? t("chat.pastChatsNone", { query })
            : t("chat.pastChatsSearched", { query });

  return (
    <div className="flex max-w-[80ch] flex-col gap-1.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <SearchIcon className="size-3.5 shrink-0" aria-hidden />
        <span role="status" className="truncate">
          {text}
        </span>
      </div>
      {search.conversations.length > 0 && (
        <ul className="space-y-0.5 border-l pl-3">
          {search.conversations.map((found) => (
            <li key={found.conversationId} className="flex flex-wrap gap-x-2">
              <Link
                page={{ to: "conversation", id: found.conversationId }}
                className="font-medium text-foreground hover:underline"
              >
                {found.title || t("shell.untitled")}
              </Link>
              <span>{relativeTime(i18n, new Date(found.date))}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
