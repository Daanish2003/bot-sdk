import { useI18n } from "@botsdk/react/provider";
import { CodeBlock, CodeBlockCode } from "@/components/ui/prompt-kit/code-block";
import { cn } from "@/lib/utils";
import { type ComponentProps, isValidElement, type ReactNode, useState } from "react";

/** Blocks longer than this many lines start collapsed. */
const collapseAbove = 15;

/** `text` indented, when it is a JSON object or array, else null. */
function prettyJson(text: string): string | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : null;
  } catch {
    return null;
  }
}

/**
 * A Message that is a JSON object or array from start to finish, indented, or null. JSON inside a
 * sentence is left to Markdown.
 */
export function wholeMessageJson(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? prettyJson(trimmed) : null;
}

/**
 * A block of code or JSON: a copy button, and a long one starts collapsed with a way to show every
 * line. A wide one scrolls inside the block.
 */
export function MessageCodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const lineCount = code.split("\n").length;
  const collapsed = lineCount > collapseAbove && !expanded;

  const copy = () => {
    // Without clipboard access (an insecure page) the button simply does nothing.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <CodeBlock>
      <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted-foreground">
        <span>{language === "plaintext" ? "" : language}</span>
        <button
          type="button"
          aria-label={t("bots.copyCode")}
          onClick={copy}
          className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {copied ? t("bots.codeCopied") : t("bots.copy")}
        </button>
      </div>
      <div
        data-collapsed={collapsed ? "" : undefined}
        className={cn("min-w-0", collapsed && "max-h-72 overflow-y-hidden")}
      >
        <CodeBlockCode code={code} language={language} />
      </div>
      {lineCount > collapseAbove && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="border-t border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {expanded ? t("bots.showFewerLines") : t("bots.showAllLines", { count: lineCount })}
        </button>
      )}
    </CodeBlock>
  );
}

function languageOf(className?: string): string {
  return className?.match(/language-(\w+)/)?.[1]?.toLowerCase() ?? "plaintext";
}

/** Markdown's `pre`, drawn as a {@link MessageCodeBlock}. A `json` fence is pretty-printed. */
export function MessagePre({ children }: ComponentProps<"pre">) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children))
    return <pre>{children}</pre>;
  const { className, children: content } = children.props;
  const language = languageOf(className);
  const code = String(content ?? "").replace(/\n$/, "");
  return (
    <MessageCodeBlock
      code={language === "json" ? (prettyJson(code) ?? code) : code}
      language={language}
    />
  );
}

/** Markdown's `table`, scrolling inside its own box when it is wider than the column. */
export function MessageTable({
  node: _node,
  ...props
}: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  );
}
