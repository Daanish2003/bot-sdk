import { cn } from "@ai-chat/ui/lib/utils";
import { isValidElement, memo, type ReactNode, useId, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { CodeBlock, CodeBlockCode } from "./code-block";

export type MarkdownProps = {
  children: string;
  id?: string;
  className?: string;
  components?: Partial<Components>;
};

function extractLanguage(className?: string): string {
  if (!className) return "plaintext";
  const match = className.match(/language-(\w+)/);
  return match?.[1]?.toLowerCase() ?? "plaintext";
}

const INITIAL_COMPONENTS: Partial<Components> = {
  // A fence is a `code` directly inside a `pre`, which `pre` below draws. Any other is inline.
  code: function CodeComponent({ node: _node, className, children, ...props }) {
    return (
      <code
        className={cn("bg-primary-foreground rounded-sm px-1 font-mono text-sm", className)}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: function PreComponent({ children }) {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(children))
      return <pre>{children}</pre>;
    const { className, children: code } = children.props;

    return (
      <CodeBlock className={className}>
        <CodeBlockCode
          code={String(code ?? "").replace(/\n$/, "")}
          language={extractLanguage(className)}
        />
      </CodeBlock>
    );
  },
  // A remote image would fetch from a third-party host (and leak the reader's IP). Only data: sources render;
  // anything else shows its alt text.
  img: function ImageComponent({ src, alt }) {
    if (typeof src === "string" && src.startsWith("data:")) return <img src={src} alt={alt} />;
    return alt ? <span className="text-muted-foreground">{alt}</span> : null;
  },
};

function MarkdownComponent({ children, id, className, components: overrides }: MarkdownProps) {
  const generatedId = useId();
  // Overrides (a link renderer, say) keep the code block renderers. Pass a stable object.
  const components = useMemo(
    () => (overrides ? { ...INITIAL_COMPONENTS, ...overrides } : INITIAL_COMPONENTS),
    [overrides],
  );

  // Parsed whole, so a footnote or reference link finds its definition in any block.
  return (
    <div className={className}>
      <ReactMarkdown
        // Strikethrough only on `~~`: a Bot's `5~10~20` is a range.
        remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkBreaks]}
        // Each Markdown's footnotes link inside it, however many are on the page.
        remarkRehypeOptions={{ clobberPrefix: `${id ?? generatedId}-` }}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
