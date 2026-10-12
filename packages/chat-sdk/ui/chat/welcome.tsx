import { useI18n } from "../../core/client/react/provider";

const suggestionKeys = [
  "chat.suggestionCtes",
  "chat.suggestionRegex",
  "chat.suggestionCompose",
] as const;

/** The New Conversation welcome: a heading and three suggestion chips that send right away. */
export function Welcome({
  onSuggest,
  disabled = false,
}: {
  onSuggest: (text: string) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const suggestions = suggestionKeys.map((key) => t(key));
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <h1 className="text-2xl font-medium tracking-tight">{t("chat.whatsOnYourMind")}</h1>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((text) => (
          <button
            key={text}
            type="button"
            disabled={disabled}
            onClick={() => onSuggest(text)}
            className="rounded-full border px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
