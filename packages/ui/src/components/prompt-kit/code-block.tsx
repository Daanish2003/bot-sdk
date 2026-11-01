import { cn } from "@ai-chat/ui/lib/utils";
import React, { useEffect, useState } from "react";
import { createBundledHighlighter, createSingletonShorthands } from "shiki/dist/core.mjs";
import type { DynamicImportLanguageRegistration } from "shiki/types";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

// Fix when vendoring: the JavaScript regex engine instead of Oniguruma, whose wasm import
// the SSR (Nitro) build can't bundle. `shiki/dist/core.mjs` skips the `unwasm` export condition,
// which would load the Oniguruma wasm anyway.
const typescript = () => import("shiki/langs/typescript.mjs");
const javascript = () => import("shiki/langs/javascript.mjs");
const shell = () => import("shiki/langs/shellscript.mjs");
const python = () => import("shiki/langs/python.mjs");
const yaml = () => import("shiki/langs/yaml.mjs");
// About 10 languages and one theme, so the rest of shiki's bundle never ships. A null prototype:
// shiki would load `Object` for a fence named `constructor`, which breaks its shared highlighter.
const languages: Record<string, DynamicImportLanguageRegistration> = Object.assign(
  Object.create(null),
  {
    typescript,
    ts: typescript,
    tsx: () => import("shiki/langs/tsx.mjs"),
    jsx: () => import("shiki/langs/jsx.mjs"),
    javascript,
    js: javascript,
    json: () => import("shiki/langs/json.mjs"),
    shellscript: shell,
    bash: shell,
    sh: shell,
    shell,
    zsh: shell,
    python,
    py: python,
    html: () => import("shiki/langs/html.mjs"),
    css: () => import("shiki/langs/css.mjs"),
    sql: () => import("shiki/langs/sql.mjs"),
    yaml,
    yml: yaml,
  },
);
const theme = "github-dark-default";

const { codeToHtml } = createSingletonShorthands(
  createBundledHighlighter({
    langs: languages,
    themes: { [theme]: () => import("shiki/themes/github-dark-default.mjs") },
    engine: () => createJavaScriptRegexEngine(),
  }),
);

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

function CodeBlockCode({ code, language = "tsx", className, ...props }: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    async function highlight() {
      if (!code) {
        setHighlightedHtml("<pre><code></code></pre>");
        return;
      }

      // An unknown language keeps the plain code.
      const html = await codeToHtml(code, { lang: language, theme }).catch(() => null);
      setHighlightedHtml(html);
    }
    highlight();
  }, [code, language]);

  const classNames = cn("w-full overflow-x-auto text-[13px] [&>pre]:px-4 [&>pre]:py-4", className);

  // SSR fallback: render plain code if not hydrated yet
  return highlightedHtml ? (
    <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div className={cn("flex items-center justify-between", className)} {...props}>
      {children}
    </div>
  );
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock };
