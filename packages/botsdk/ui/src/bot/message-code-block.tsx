import { useI18n } from "@botsdk/react/provider";
import { CodeBlock, CodeBlockCode } from "@/components/ui/prompt-kit/code-block";
import { cn } from "@/lib/utils";
import { type ComponentProps, isValidElement, type ReactNode, useEffect, useState } from "react";

/** Blocks longer than this many lines start collapsed. */
const collapseAbove = 15;

/**
 * `text` as a JSON object or array, indented, or null when it is not one. When indenting would
 * change a value (a number too big for a double, `1.0`, an escape), `text` comes back as it was.
 */
function indentJson(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  // Without its whitespace, `text` must read the same as the value written back out.
  const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) =>
    token.startsWith('"') ? token : "",
  );
  return compact === JSON.stringify(value) ? JSON.stringify(value, null, 2) : text;
}

/**
 * A Message that is a JSON object or array from start to finish, indented, or null. JSON inside a
 * sentence is left to Markdown.
 */
export function wholeMessageJson(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? indentJson(trimmed) : null;
}

/**
 * A block of code or JSON: a copy button, and a long one starts collapsed with a way to show every
 * line. A wide one scrolls inside the block.
 */
export function MessageCodeBlock({ code, language }: { code: string; language: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Cleared on unmount, so the label never changes after the block is gone.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const lineCount = code.split("\n").length;
  const collapsed = lineCount > collapseAbove && !expanded;

  const copy = () => {
    // Without clipboard access (an insecure page) the button simply does nothing.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => setCopied(true))
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
      code={language === "json" ? (indentJson(code) ?? code) : code}
      language={language}
    />
  );
}

/** Markdown's `table`, scrolling inside its own box when it is wider than the column. */
export function MessageTable({
  node: _node,
  ...props
}: ComponentProps<"table"> & { node?: unknown }) {
  // Focusable, so a keyboard user can scroll a wide table.
  return (
    <div className="overflow-x-auto" tabIndex={0}>
      <table {...props} />
    </div>
  );
}
