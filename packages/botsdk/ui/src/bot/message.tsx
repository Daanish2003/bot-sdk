import { Markdown } from "@/components/ui/prompt-kit/markdown";
import { cn } from "@/lib/utils";
import { dateFormat } from "@botsdk/react/intl";
import { useI18n } from "@botsdk/react/provider";
import type { ComponentProps, ReactNode } from "react";

import { MessageCodeBlock, MessagePre, MessageTable, wholeMessageJson } from "./message-code-block";

type MarkdownComponents = NonNullable<ComponentProps<typeof Markdown>["components"]>;

const linkSchemes = new Set(["http:", "https:", "mailto:"]);

/** The address a link may go to, as the browser reads it, or null when it may not work. */
function safeHref(href: string | undefined): string | null {
  try {
    const url = new URL(href ?? "");
    return linkSchemes.has(url.protocol) ? url.href : null;
  } catch {
    // Relative, or not an address at all.
    return null;
  }
}

/**
 * The safety rules, passed to whichever copy of the Markdown component the Host has. A Host's copy
 * may have no rules of its own for links and images, so these are always supplied from here. Raw
 * HTML needs no rule: Markdown turns it into text unless a Host adds a plugin to run it.
 */
const safeComponents: MarkdownComponents = {
  a: function SafeLink({ href, children, id, className, ...rest }) {
    // A footnote's own links, which only remark writes: raw HTML can't set these attributes.
    if (href?.startsWith("#") && ("data-footnote-ref" in rest || "data-footnote-backref" in rest)) {
      const { node: _node, title: _title, ...footnote } = rest;
      return (
        <a href={href} id={id} className={className} {...footnote}>
          {children}
        </a>
      );
    }
    const safe = safeHref(href);
    if (!safe) return <>{children}</>;
    // The hover shows the real address. The author's title never reaches the DOM.
    return (
      <a href={safe} title={safe} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  pre: MessagePre,
  table: MessageTable,
  // A remote image tells its server the reader's IP, so an image is only ever its alt text.
  img: function SafeImage({ alt }) {
    return alt ? <span className="text-muted-foreground">{alt}</span> : null;
  },
};

/** A Bot's Markdown as a clean document, under the safety rules. */
export function MessageMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <Markdown
      components={safeComponents}
      className={cn(
        "prose prose-sm max-w-none min-w-0 wrap-anywhere dark:prose-invert prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        className,
      )}
    >
      {children}
    </Markdown>
  );
}

/** A Message's time, shown on hover and on keyboard focus of its Message. */
function HoverTime({ at, own }: { at: Date; own: boolean }) {
  const { locale } = useI18n();
  return (
    <time
      data-hover-time
      dateTime={at.toISOString()}
      className={cn(
        "text-xs text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100",
        own && "self-end",
      )}
    >
      {dateFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at)}
    </time>
  );
}

/**
 * One Message in a thread. The user's is a bubble on the right, shown exactly as typed. A Bot's
 * runs the column's full width as a clean document. `children` sit under the text. While `pending`
 * (being sent) it is dimmed. `header` sits above a Bot's text (a Room's avatar, name and time).
 * `hoverTime` shows the Message's time on hover and on keyboard focus.
 */
export function Message({
  id,
  role,
  text,
  pending,
  hideText,
  header,
  hoverTime,
  children,
}: {
  id: string;
  role: string;
  text: string;
  pending?: boolean;
  hideText?: boolean;
  header?: ReactNode;
  hoverTime?: Date;
  children?: ReactNode;
}) {
  const own = role === "user";
  const json = own ? null : wholeMessageJson(text);
  return (
    <div
      // Focusable so the time shows for the keyboard too.
      tabIndex={hoverTime ? 0 : undefined}
      className={cn(
        "group relative flex min-w-0 flex-col gap-1",
        own ? "max-w-[75%] self-end" : "self-stretch",
      )}
    >
      {!own && header}
      {!hideText && (
        <div
          data-bot-message
          data-id={id}
          data-role={role}
          className={cn(
            "min-w-0 text-sm",
            own &&
              "self-end rounded-2xl bg-primary px-3 py-2 wrap-anywhere whitespace-pre-wrap text-primary-foreground",
            pending && "opacity-70",
          )}
        >
          {own ? (
            text
          ) : json ? (
            <MessageCodeBlock code={json} language="json" />
          ) : (
            <MessageMarkdown>{text}</MessageMarkdown>
          )}
        </div>
      )}
      {children}
      {hoverTime && <HoverTime at={hoverTime} own={own} />}
    </div>
  );
}
