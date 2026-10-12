import {
  artifactFileName,
  artifactKindLabels,
  type ArtifactKind,
} from "../../core/shared/chat/artifact";
import { useOrpc } from "../../core/client/react/provider";
import { CodeBlock, CodeBlockCode } from "@/components/ui/prompt-kit/code-block";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon, Loader2Icon, XIcon } from "lucide-react";

import type { ArtifactRef } from "./artifact-card";

/** One version of an Artifact, as the panel shows it: its title, kind, language and content. */
export type ArtifactVersionContent = {
  title: string;
  kind: ArtifactKind;
  language: string | null;
  content: string;
};

/**
 * The side panel an Artifact opens in (spec #304): the version a card points at, its source
 * highlighted, with copy, download and close. It loads the version's content on demand, so the
 * reply never carries it.
 */
export function ArtifactPanel({
  artifact,
  onClose,
}: {
  artifact: ArtifactRef;
  onClose: () => void;
}) {
  const orpc = useOrpc();
  const version = useQuery(
    orpc.artifact.version.queryOptions({
      input: { artifactId: artifact.artifactId, number: artifact.version },
    }),
  );
  if (version.data) {
    return <ArtifactPanelView version={version.data} onClose={onClose} />;
  }
  return (
    <PanelFrame onClose={onClose}>
      {version.isError ? (
        <p className="p-4 text-sm text-muted-foreground" role="alert">
          This Artifact couldn't be loaded.
        </p>
      ) : (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden /> Loading…
        </p>
      )}
    </PanelFrame>
  );
}

/** The panel with its content: the header's title, kind and actions, and the source. */
export function ArtifactPanelView({
  version,
  onClose,
}: {
  version: ArtifactVersionContent;
  onClose: () => void;
}) {
  const fileName = artifactFileName({
    title: version.title,
    kind: version.kind,
    language: version.language,
  });
  return (
    <PanelFrame onClose={onClose}>
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{version.title}</span>
        <span className="rounded border px-1.5 text-[10px] text-muted-foreground">
          {artifactKindLabels[version.kind]}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy"
          title="Copy"
          onClick={() => void copyArtifact(version.content)}
        >
          <CopyIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Download"
          title="Download"
          data-download-name={fileName}
          onClick={() => downloadArtifact(fileName, version.content, version.kind)}
        >
          <DownloadIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close" title="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <CodeBlock>
          <CodeBlockCode
            code={version.content}
            language={codeLanguageOf(version.kind, version.language)}
          />
        </CodeBlock>
      </div>
    </PanelFrame>
  );
}

/**
 * The split pane's side: half the width beside the chat, and the whole screen at phone width,
 * where close brings the chat back.
 */
function PanelFrame({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <aside
      aria-label="Artifact"
      data-artifact-panel
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      className={cn(
        "flex min-h-0 flex-col bg-background",
        "max-md:fixed max-md:inset-0 max-md:z-50 md:w-1/2 md:shrink-0 md:border-l",
      )}
    >
      {children}
    </aside>
  );
}

/** The code language a panel's source is highlighted as. Unknown ones show as plain text. */
export function codeLanguageOf(kind: ArtifactKind, language: string | null): string {
  switch (kind) {
    case "code":
      return language ?? "text";
    case "markdown":
      return "markdown";
    case "html":
      return "html";
    case "svg":
      return "xml";
    case "mermaid":
      return "text";
  }
}

/** Copies a version's content to the clipboard. */
export function copyArtifact(content: string): Promise<void> {
  return navigator.clipboard.writeText(content);
}

const mimeTypes: Partial<Record<ArtifactKind, string>> = {
  html: "text/html",
  svg: "image/svg+xml",
  markdown: "text/markdown",
};

/** Saves a version's content as a file named `fileName`. */
export function downloadArtifact(fileName: string, content: string, kind: ArtifactKind) {
  const url = URL.createObjectURL(
    new Blob([content], { type: `${mimeTypes[kind] ?? "text/plain"};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
