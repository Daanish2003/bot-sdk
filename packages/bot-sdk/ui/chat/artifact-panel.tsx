import {
  artifactFileName,
  type ArtifactKind,
  updateArtifactToolName,
} from "../../plugins/assistant/shared/chat/artifact";
import type { UIMessage } from "@tanstack/ai-react";
import type { ToolCallView } from "../../plugins/assistant/shared/chat/tool-call";
import type { MessageKey } from "../../core/shared/i18n";
import { messageInfo } from "../../plugins/assistant/client/chat";
import { useI18n, useOrpc } from "../../core/client/react/provider";
import { CodeBlock, CodeBlockCode } from "@/components/ui/prompt-kit/code-block";
import { Markdown } from "@/components/ui/prompt-kit/markdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon, Loader2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { liveArtifactOf } from "./artifact-live";
import { artifactKindKeys, artifactRefOf, type ArtifactRef, updatingTo } from "./artifact-card";
import {
  artifactFrameDocument,
  artifactFrameSandbox,
  frameMessageOf,
  svgDataUrl,
  type FrameMessage,
} from "./artifact-sandbox";

/** One version of an Artifact, as the panel shows it: its number, title, kind, language and content. */
export type ArtifactVersionContent = {
  number: number;
  title: string;
  kind: ArtifactKind;
  language: string | null;
  content: string;
};

/**
 * The versions of one Artifact on the Active Branch, newest first (ADR 0016): each `artifact` part
 * on the path names one. Versions written on other Branches never appear, since their Messages
 * aren't on the path. A Message still streaming is left out: its version has only a temporary id,
 * which the server does not know, until the reply is stored.
 */
export function artifactVersionsOn(
  messages: ReadonlyArray<{ id: string; parts: ReadonlyArray<unknown>; metadata?: unknown }>,
  artifactId: string,
): ArtifactRef[] {
  const versions: ArtifactRef[] = [];
  for (const message of messages) {
    if (messageInfo(message as UIMessage).status === "streaming") continue;
    for (const part of message.parts) {
      const call = part as { type?: unknown; output?: unknown };
      if (call.type !== "tool-call") continue;
      const ref = artifactRefOf(call.output);
      if (ref?.artifactId === artifactId) versions.push({ ...ref, messageId: message.id });
    }
  }
  return versions.sort((a, b) => b.version - a.version);
}

/**
 * The side panel an Artifact opens in (spec #304): the version a card points at, its source
 * highlighted, with copy, download and close. It loads the version's content on demand, so the
 * reply never carries it. `versions` are the Artifact's versions on the Active Branch; choosing one
 * is only a view (`onSelect`), and changes nothing the Model sees.
 */
export function ArtifactPanel({
  artifact,
  versions = [],
  onSelect,
  onClose,
  sharedToken,
}: {
  artifact: ArtifactRef;
  versions?: ArtifactRef[];
  onSelect?: (ref: ArtifactRef) => void;
  onClose: () => void;
  /** Set on a Shared link: the version is read through its token, and the panel is read-only. */
  sharedToken?: string;
}) {
  const orpc = useOrpc();
  const { t } = useI18n();
  const version = useQuery(
    sharedToken
      ? orpc.share.artifactVersion.queryOptions({
          input: { token: sharedToken, artifactId: artifact.artifactId, number: artifact.version },
        })
      : orpc.artifact.version.queryOptions({
          input: {
            artifactId: artifact.artifactId,
            number: artifact.version,
            messageId: artifact.messageId,
          },
        }),
  );
  if (version.data) {
    return (
      <ArtifactPanelView
        version={version.data}
        versions={versions}
        onSelect={onSelect}
        onClose={onClose}
        readOnly={Boolean(sharedToken)}
      />
    );
  }
  return (
    <PanelFrame onClose={onClose}>
      {version.isError ? (
        <p className="p-4 text-sm text-muted-foreground" role="alert">
          {t("chat.artifactLoadFailed")}
        </p>
      ) : (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" aria-hidden /> {t("shell.loading")}
        </p>
      )}
    </PanelFrame>
  );
}

/** The Preview and Code tabs of a non-code Artifact, and the text each tab shows. */
const tabNames = ["preview", "code"] as const;
const tabKeys: Record<(typeof tabNames)[number], MessageKey> = {
  preview: "chat.artifactTabPreview",
  code: "chat.artifactTabCode",
};

/** The panel with its content: the header's title, kind, version and actions, and the source. */
export function ArtifactPanelView({
  version,
  versions = [],
  onSelect,
  onClose,
  readOnly = false,
}: {
  version: ArtifactVersionContent;
  versions?: ArtifactRef[];
  onSelect?: (ref: ArtifactRef) => void;
  onClose: () => void;
  /** On a Shared link: says so under the header; copy, download and close stay. */
  readOnly?: boolean;
}) {
  const fileName = artifactFileName({
    title: version.title,
    kind: version.kind,
    language: version.language,
  });
  const latest = versions[0]?.version;
  const { t } = useI18n();
  // Code kinds have only a source view; every other kind opens on its Preview.
  const [tab, setTab] = useState<"preview" | "code">(version.kind === "code" ? "code" : "preview");
  const showPreview = tab === "preview" && version.kind !== "code";
  return (
    <PanelFrame onClose={onClose}>
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{version.title}</span>
        <span className="rounded border px-1.5 text-[10px] text-muted-foreground">
          {t(artifactKindKeys[version.kind])}
        </span>
        {version.kind !== "code" && (
          <div
            role="tablist"
            aria-label={t("chat.artifactViewLabel")}
            className="flex rounded border text-xs"
          >
            {tabNames.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={tab === name}
                onClick={() => setTab(name)}
                className={cn(
                  "px-2 py-0.5 capitalize",
                  tab === name ? "bg-muted font-medium" : "text-muted-foreground",
                )}
              >
                {t(tabKeys[name])}
              </button>
            ))}
          </div>
        )}
        {versions.length > 1 && (
          <select
            aria-label={t("chat.artifactVersionLabel")}
            className="rounded border bg-background px-1 text-xs"
            value={version.number}
            onChange={(event) => {
              const chosen = versions.find((ref) => ref.version === Number(event.target.value));
              if (chosen) onSelect?.(chosen);
            }}
          >
            {versions.map((ref) => (
              <option key={`${ref.messageId}:${ref.version}`} value={ref.version}>
                {ref.version === latest
                  ? t("chat.artifactVersionLatest", { version: ref.version })
                  : t("chat.artifactVersionNumber", { version: ref.version })}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.copy")}
          title={t("chat.copy")}
          onClick={() => void copyArtifact(version.content)}
        >
          <CopyIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.download")}
          title={t("chat.download")}
          data-download-name={fileName}
          onClick={() => downloadArtifact(fileName, version.content, version.kind)}
        >
          <DownloadIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.close")}
          title={t("chat.close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>
      {readOnly && (
        <p className="border-b bg-muted px-3 py-1 text-xs text-muted-foreground">
          {t("chat.artifactSharedReadOnly")}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {showPreview ? (
          <ArtifactPreview version={version} />
        ) : (
          <CodeBlock>
            <CodeBlockCode
              code={version.content}
              language={codeLanguageOf(version.kind, version.language)}
            />
          </CodeBlock>
        )}
      </div>
    </PanelFrame>
  );
}

/**
 * The panel for an Artifact call that has no saved version yet (spec #304): a create or a full
 * rewrite shows its source filling in, as it streams; an edits update keeps the previous version
 * under an "Updating to vN…" notice until the change lands. A call that ends unsaved shows its
 * partial source under "This Artifact wasn't saved".
 */
export function LiveArtifactPanel({
  call,
  latest,
  onClose,
}: {
  call: ToolCallView;
  /** The Artifact's newest version on the Branch, for an update (the one it changes). */
  latest?: ArtifactRef;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const live = liveArtifactOf(i18n, call);
  if (call.name !== updateArtifactToolName || !latest) {
    return (
      <LiveArtifactView
        title={live.title}
        kind={live.kind}
        language={live.language}
        source={live.content ?? ""}
        notice={live.notice}
        onClose={onClose}
      />
    );
  }
  return <LiveUpdatePanel call={call} latest={latest} onClose={onClose} />;
}

/** The live panel for an update: its source is the previous version until a full rewrite streams in. */
function LiveUpdatePanel({
  call,
  latest,
  onClose,
}: {
  call: ToolCallView;
  latest: ArtifactRef;
  onClose: () => void;
}) {
  const orpc = useOrpc();
  const i18n = useI18n();
  const previous = useQuery(
    orpc.artifact.version.queryOptions({
      input: {
        artifactId: latest.artifactId,
        number: latest.version,
        messageId: latest.messageId,
      },
    }),
  );
  if (!previous.data) {
    return (
      <PanelFrame onClose={onClose}>
        {previous.isError ? (
          <p className="p-4 text-sm text-muted-foreground" role="alert">
            {i18n.t("chat.artifactLoadFailed")}
          </p>
        ) : (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" aria-hidden /> {i18n.t("shell.loading")}
          </p>
        )}
      </PanelFrame>
    );
  }
  const live = liveArtifactOf(i18n, call);
  const version = previous.data;
  const title = (call.args as { title?: unknown } | undefined)?.title;
  return (
    <LiveArtifactView
      title={typeof title === "string" ? title : version.title}
      kind={version.kind}
      language={version.language}
      source={live.content ?? version.content}
      notice={
        live.edits && live.state === "updating" ? updatingTo(i18n, latest.version) : live.notice
      }
      onClose={onClose}
    />
  );
}

/**
 * The panel while an Artifact's source streams in, or for a call that ended unsaved: the source as
 * code, under an optional notice. It has no tabs, since there is no preview until the version saves.
 */
export function LiveArtifactView({
  title,
  kind,
  language,
  source,
  notice,
  onClose,
}: {
  title: string;
  kind: ArtifactKind;
  language: string | null;
  source: string;
  notice?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <PanelFrame onClose={onClose}>
      <header className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="rounded border px-1.5 text-[10px] text-muted-foreground">
          {t(artifactKindKeys[kind])}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("chat.close")}
          title={t("chat.close")}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>
      {notice && (
        <p role="status" className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <CodeBlock>
          <CodeBlockCode code={source} language={codeLanguageOf(kind, language)} />
        </CodeBlock>
      </div>
    </PanelFrame>
  );
}

/** The Preview of a version: Markdown rendered, SVG drawn, HTML and Mermaid run in the sandbox. */
function ArtifactPreview({ version }: { version: ArtifactVersionContent }) {
  switch (version.kind) {
    case "markdown":
      return <Markdown>{version.content}</Markdown>;
    case "svg":
      return <img src={svgDataUrl(version.content)} alt={version.title} className="max-w-full" />;
    case "html":
    case "mermaid":
      return (
        <SandboxedFrame
          title={version.title}
          srcDoc={artifactFrameDocument({ kind: version.kind, content: version.content })}
        />
      );
    case "code":
      return null;
  }
}

/**
 * The frame an HTML or Mermaid Preview runs in. It sizes itself to the height its document reports,
 * and shows a script error inside it as a banner that leaves the preview running. It takes a
 * message only from its own window (see `frameMessageOf`).
 */
function SandboxedFrame({ srcDoc, title }: { srcDoc: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { t } = useI18n();
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message: FrameMessage | undefined = frameMessageOf(event, frame.current?.contentWindow);
      if (message?.type === "resize") setHeight(message.height);
      if (message?.type === "error") setError(message.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="rounded border border-destructive/40 px-2 py-1 text-xs">
          {t("chat.artifactPreviewError", { error })}
        </p>
      )}
      <iframe
        ref={frame}
        title={title}
        srcDoc={srcDoc}
        sandbox={artifactFrameSandbox}
        style={{ height: height ?? 300 }}
        className="w-full rounded border bg-background"
      />
    </div>
  );
}

/**
 * The split pane's side: half the width beside the chat, and the whole screen at phone width,
 * where close brings the chat back.
 */
function PanelFrame({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <aside
      aria-label={t("chat.artifactPanel")}
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
