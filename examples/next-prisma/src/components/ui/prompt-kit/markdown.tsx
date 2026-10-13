import { cn } from "@/lib/utils";
import { marked } from "marked";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockCode } from "./code-block";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
  /** Hrefs kept as written, past react-markdown's URL allowlist (a reply's `excerpt:<n>` links). */
  keepUrl?: (href: string) => boolean;
};

function parseMarkdownIntoBlocks(markdown: string): string[] {
  const tokens = marked.lexer(markdown);
  return tokens.map((token) => token.raw);
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext";
  const match = className.match(/language-(\w+)/);
  return match?.[1] ?? "plaintext";
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line;

    if (isInline) {
      return (
        <span
          className={cn("bg-primary-foreground rounded-sm px-1 font-mono text-sm", className)}
          {...props}
        >
          {children}
        </span>
      );
    }

    const language = extractLanguage(className);

    return (
      <CodeBlock className={className}>
        <CodeBlockCode code={children as string} language={language} />
      </CodeBlock>
    );
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>;
  },
  // A remote image would fetch from a third-party host (and leak the reader's IP). Only data: sources render;
  // anything else shows its alt text.
  img: function ImageComponent({ src, alt }) {
    if (typeof src === "string" && src.startsWith("data:")) return <img src={src} alt={alt} />;
    return alt ? <span className="text-muted-foreground">{alt}</span> : null;
  },
};

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
    keepUrl,
  }: {
    content: string;
    components?: Partial<Components>;
    keepUrl?: (href: string) => boolean;
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
        urlTransform={(url) => (keepUrl?.(url) ? url : defaultUrlTransform(url))}
      >
        {content}
      </ReactMarkdown>
    );
  },
  function propsAreEqual(prevProps, nextProps) {
    return (
      prevProps.content === nextProps.content &&
      prevProps.components === nextProps.components &&
      prevProps.keepUrl === nextProps.keepUrl
    );
  },
);

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownComponent({
  children,
  id,
  className,
  components: overrides,
  keepUrl,
}: MarkdownProps) {
  const generatedId = useId();
  const blockId = id ?? generatedId;
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
  // Overrides (a link renderer, say) keep the code block renderers. Pass a stable object.
  const components = useMemo(
    () => (overrides ? { ...INITIAL_COMPONENTS, ...overrides } : INITIAL_COMPONENTS),
    [overrides],
  );

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
          keepUrl={keepUrl}
        />
      ))}
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
